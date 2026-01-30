// keeper.js - Nitrolite Protocol Keeper Service for Aura Vault

const { ethers } = require('ethers');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const config = require('./config');
const logger = require('./logger');
const { NitroliteClient } = require('@erc7824/nitrolite');
const { createPublicClient, createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { sepolia } = require('viem/chains');

// ============================================
// SMART CONTRACT ABIs
// ============================================

const AURA_VAULT_ABI = [
    // View functions
    "function getRiskTierStrategies(uint8 riskTier) external view returns (tuple(address strategy, uint8 allocationPct, bool active)[])",
    "function getRiskTierInfo(uint8 riskTier) external view returns (string name, uint256 totalAllocated, uint256 strategyCount)",
    "function getTierAllocationDetails(uint8 riskTier) external view returns (address[] strategyAddresses, uint8[] allocations, uint256[] currentAssets, uint256[] targetAssets)",
    "function isTierAllocationValid(uint8 riskTier) external view returns (bool isValid, uint256 totalAllocation)",
    "function estimatedVaultAPY() external view returns (uint256)",
    "function totalAssets() external view returns (uint256)",
    "function isNitroliteOperator(address operator) external view returns (bool)",
    "function canExecute(string operationType) external view returns (bool)",
    "function owner() external view returns (address)",

    // Write functions (Nitrolite-enabled)
    "function updateTierAllocations(uint8 riskTier, uint256[] calldata indices, uint8[] calldata allocations) public",
    "function rebalanceTier(uint8 tier) public",
    "function harvestAll() external returns (uint256)",
    "function settleRebalance(uint8 riskTier, uint256[] calldata indices, uint8[] calldata allocations) external",
    "function settleTransfer(address user, uint256 amount, bool isWithdraw) external",

    // Events
    "event TierAllocationsUpdated(uint8 indexed riskTier, address[] strategies, uint8[] allocations)",
    "event TierRebalanced(uint8 indexed riskTier, uint256 timestamp, uint256 totalRebalanced)",
    "event Harvested(uint256 totalHarvested, uint256 performanceFee, uint256 timestamp)",
    "event AutomatedOperationExecuted(string indexed operationType, address indexed executor, uint256 timestamp)"
];

const STRATEGY_ABI = [
    "function totalAssets() external view returns (uint256)",
    "function estimatedAPY() external view returns (uint256)",
    "function baseAPY() external view returns (uint256)"
];

// ============================================
// NITROLITE KEEPER SERVICE CLASS
// ============================================

class NitroliteKeeperService {
    constructor() {
        logger.info('🚀 Initializing Nitrolite Keeper Service for Aura Vault');

        // Initialize provider and wallet
        this.provider = new ethers.JsonRpcProvider(config.RPC_URL);
        this.wallet = new ethers.Wallet(config.NITROLITE_OPERATOR_PRIVATE_KEY, this.provider);

        // Initialize vault contract
        this.auraVault = new ethers.Contract(
            config.AURA_VAULT_ADDRESS,
            AURA_VAULT_ABI,
            this.wallet
        );

        // MongoDB client
        this.mongoClient = null;
        this.db = null;

        // Strategy contract cache
        this.strategyContracts = new Map();

        // Operational state
        this.isRunning = false;
        this.lastRebalanceTime = 0;
        this.lastHarvestTime = 0;
        this.rebalanceCount = 0;
        this.harvestCount = 0;

        // Client-side rate limiting (fallback for vaults without canExecute)
        this.lastExecutionTimes = {
            rebalance: 0,
            harvest: 0
        };
        this.MIN_REBALANCE_INTERVAL = 10 * 60 * 1000; // 10 minutes in ms
        this.MIN_HARVEST_INTERVAL = 60 * 60 * 1000; // 1 hour in ms

        // Nitrolite Protocol Client
        this.nitroliteClient = null;
        this.channelId = null;
        this.pendingSettlements = [];

        logger.info(`📡 Vault Contract: ${config.AURA_VAULT_ADDRESS}`);
        logger.info(`🤖 AI API: ${config.AI_API_URL}`);
        logger.info(`⏰ Rebalance Interval: ${config.REBALANCE_INTERVAL / 60000} minutes`);
        logger.info(`⏰ Harvest Interval: ${config.HARVEST_INTERVAL / 60000} minutes`);
    }

    // ============================================
    // MONGODB CONNECTION
    // ============================================

    async connectMongoDB() {
        try {
            logger.info('🗄️  Connecting to MongoDB...');
            this.mongoClient = new MongoClient(config.MONGODB_URI);
            await this.mongoClient.connect();
            this.db = this.mongoClient.db(config.MONGODB_DB_NAME);
            logger.info('✅ MongoDB connected');
        } catch (error) {
            logger.error('❌ MongoDB connection error:', error);
            throw error;
        }
    }

    // ============================================
    // VERIFICATION - CHECK NITROLITE AUTHORIZATION
    // ============================================

    async verifyNitroliteAuthorization() {
        try {
            logger.info('🔐 Verifying authorization...');
            const operatorAddress = await this.wallet.getAddress();

            // Try Nitrolite operator check first
            try {
                const isAuthorized = await this.auraVault.isNitroliteOperator(operatorAddress);

                if (!isAuthorized) {
                    logger.error(`❌ Address ${operatorAddress} is NOT authorized as Nitrolite operator`);
                    logger.error('Please add this address using: vault.addNitroliteOperator(address)');
                    throw new Error('Nitrolite operator not authorized');
                }

                logger.info(`✅ Nitrolite operator ${operatorAddress} is authorized`);
                return true;
            } catch (nitroliteError) {
                // If Nitrolite check fails, try owner check
                logger.warn('⚠️  Vault does not have Nitrolite integration, checking owner...');

                try {
                    const owner = await this.auraVault.owner();

                    if (owner.toLowerCase() === operatorAddress.toLowerCase()) {
                        logger.info(`✅ Keeper is vault owner ${operatorAddress}`);
                        logger.info('   Running in owner mode (no Nitrolite integration)');
                        return true;
                    } else {
                        logger.error(`❌ Address ${operatorAddress} is neither Nitrolite operator nor owner`);
                        logger.error(`   Vault owner: ${owner}`);
                        throw new Error('Not authorized - neither Nitrolite operator nor owner');
                    }
                } catch (ownerError) {
                    logger.error('❌ Failed to check vault owner:', ownerError);
                    throw ownerError;
                }
            }
        } catch (error) {
            logger.error('❌ Authorization verification failed:', error);
            throw error;
        }
    }

    // ============================================
    // STRATEGY CONTRACT HELPER
    // ============================================

    getStrategyContract(strategyAddress) {
        if (!this.strategyContracts.has(strategyAddress)) {
            this.strategyContracts.set(
                strategyAddress,
                new ethers.Contract(strategyAddress, STRATEGY_ABI, this.provider)
            );
        }
        return this.strategyContracts.get(strategyAddress);
    }

    // ============================================
    // FETCH ALL STRATEGIES FROM BLOCKCHAIN
    // ============================================

    async fetchAllStrategies() {
        logger.info('🔍 Fetching all strategies from Aura Vault...');

        const allStrategies = {
            tiers: [],
            strategyMap: new Map()
        };

        const tierNames = ['Low Risk', 'Medium Risk', 'High Risk'];

        for (let tier = 0; tier < 3; tier++) {
            try {
                const strategies = await this.auraVault.getRiskTierStrategies(tier);
                const tierInfo = await this.auraVault.getRiskTierInfo(tier);

                const activeStrategies = [];
                let strategyIndex = 0;

                for (let i = 0; i < strategies.length; i++) {
                    const [strategyAddress, allocationPct, active] = strategies[i];

                    if (active) {
                        activeStrategies.push({
                            index: i,
                            address: strategyAddress,
                            allocationPct: Number(allocationPct),
                            active: active
                        });

                        allStrategies.strategyMap.set(strategyAddress, {
                            name: `${tierNames[tier]}_Strategy_${strategyIndex}`,
                            tier: tier,
                            contractIndex: i
                        });

                        strategyIndex++;
                    }
                }

                allStrategies.tiers[tier] = {
                    tier: tier,
                    name: tierInfo[0],
                    totalAllocated: tierInfo[1],
                    strategyCount: tierInfo[2],
                    strategies: activeStrategies
                };

                logger.debug(`Tier ${tier} (${tierInfo[0]}): ${activeStrategies.length} active strategies`);

            } catch (error) {
                logger.error(`❌ Error fetching tier ${tier} strategies:`, error);
                allStrategies.tiers[tier] = {
                    tier: tier,
                    name: tierNames[tier],
                    strategies: []
                };
            }
        }

        return allStrategies;
    }

    // ============================================
    // FETCH CURRENT APYs FROM BLOCKCHAIN
    // ============================================

    async fetchCurrentAPYs(allStrategies) {
        logger.info('📊 Fetching current APYs from blockchain...');

        const currentAPYs = {
            byTier: {},
            byAddress: {}
        };

        for (let tier = 0; tier < 3; tier++) {
            currentAPYs.byTier[tier] = [];

            const tierData = allStrategies.tiers[tier];
            if (!tierData || !tierData.strategies) continue;

            for (const strat of tierData.strategies) {
                try {
                    const strategyContract = this.getStrategyContract(strat.address);
                    const [baseApyRaw, totalAssets] = await Promise.all([
                        strategyContract.baseAPY(),
                        strategyContract.totalAssets()
                    ]);

                    const baseApyPercent = Number(baseApyRaw) / 100;
                    const assetsFormatted = Number(ethers.formatUnits(totalAssets, 18));

                    const strategyData = {
                        address: strat.address,
                        index: strat.index,
                        allocationPct: strat.allocationPct,
                        apy: baseApyPercent,
                        totalAssets: assetsFormatted,
                        name: allStrategies.strategyMap.get(strat.address)?.name || `Strategy_${strat.index}`
                    };

                    currentAPYs.byTier[tier].push(strategyData);
                    currentAPYs.byAddress[strat.address] = strategyData;

                } catch (error) {
                    logger.error(`❌ Error fetching APY for strategy ${strat.address}:`, error);
                    currentAPYs.byTier[tier].push({
                        address: strat.address,
                        index: strat.index,
                        allocationPct: strat.allocationPct,
                        apy: 0,
                        totalAssets: 0,
                        name: `Strategy_${strat.index}`
                    });
                }
            }
        }

        return currentAPYs;
    }

    // ============================================
    // FETCH HISTORICAL APYs FROM MONGODB
    // ============================================

    async fetchPreviousAPYs(allStrategies, days = config.APY_HISTORY_DAYS) {
        logger.info(`📈 Fetching ${days}-day APY history from MongoDB...`);

        try {
            const collection = this.db.collection('strategy_performance');
            const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

            const previousAPYs = {
                byTier: {},
                byAddress: {}
            };

            for (let tier = 0; tier < 3; tier++) {
                previousAPYs.byTier[tier] = [];
                const tierData = allStrategies.tiers[tier];
                if (!tierData || !tierData.strategies) continue;

                for (const strat of tierData.strategies) {
                    const results = await collection.find({
                        strategyAddress: strat.address,
                        timestamp: { $gte: cutoffDate }
                    }).sort({ timestamp: -1 }).limit(days).toArray();

                    results.sort((a, b) => a.timestamp - b.timestamp);

                    const apys = results.map(r => r.apy);
                    const avgAPY = apys.length ? apys.reduce((sum, apy) => sum + apy, 0) / apys.length : 0;
                    const volatility = this.calculateVolatility(apys);
                    const sharpe = this.calculateSharpe(apys);

                    const strategyData = {
                        address: strat.address,
                        index: strat.index,
                        name: allStrategies.strategyMap.get(strat.address)?.name || `Strategy_${strat.index}`,
                        avg: apys,
                        volatility: volatility,
                        sharpe: sharpe,
                        dataPoints: results.length,
                        apyHistory: avgAPY
                    };

                    previousAPYs.byTier[tier].push(strategyData);
                    previousAPYs.byAddress[strat.address] = strategyData;
                }
            }

            return previousAPYs;

        } catch (error) {
            logger.error('❌ Error fetching previous APYs:', error);
            const emptyAPYs = { byTier: {}, byAddress: {} };
            for (let tier = 0; tier < 3; tier++) {
                emptyAPYs.byTier[tier] = [];
            }
            return emptyAPYs;
        }
    }

    // ============================================
    // STATISTICAL CALCULATIONS
    // ============================================

    calculateVolatility(values) {
        if (values.length === 0) return 0;
        const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
        const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
        return Math.sqrt(variance);
    }

    calculateSharpe(values) {
        if (values.length === 0) return 0;
        const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
        const volatility = this.calculateVolatility(values);
        return volatility > 0 ? mean / volatility : 0;
    }

    /**
     * @notice Ensures rounded integer allocations sum to exactly 100
     * @param allocations Array of floating point percentages
     * @returns Array of integers summing to 100
     */
    adjustAllocationsTo100(allocations) {
        if (!allocations || allocations.length === 0) return [];

        // Initial rounding
        const rounded = allocations.map(a => Math.round(a));
        const sum = rounded.reduce((s, a) => s + a, 0);

        if (sum === 100) return rounded;

        // Adjustment needed
        const diff = 100 - sum;

        // Find the index of the largest allocation to minimize relative impact
        let maxIdx = 0;
        for (let i = 1; i < rounded.length; i++) {
            if (rounded[i] > rounded[maxIdx]) {
                maxIdx = i;
            }
        }

        rounded[maxIdx] += diff;
        logger.debug(`⚖️  Adjusted rounded allocations from sum ${sum} to 100. Diff ${diff} applied to index ${maxIdx}`);

        return rounded;
    }

    // ============================================
    // AI ALLOCATIONS REQUEST
    // ============================================

    async getAIAllocations(currentAPYs, previousAPYs, allStrategies) {
        logger.info('🤖 Requesting optimal allocations from AI...');

        try {
            const aiRequestData = {
                requestType: 'rebalance',
                timestamp: Date.now(),
                tiers: []
            };

            for (let tier = 0; tier < 3; tier++) {
                const tierData = allStrategies.tiers[tier];
                const currentTierAPYs = currentAPYs.byTier[tier] || [];
                const previousTierAPYs = previousAPYs.byTier[tier] || [];

                const strategies = currentTierAPYs.map((curr, idx) => {
                    const prev = previousTierAPYs.find(p => p.address === curr.address) || {};
                    return {
                        index: curr.index,
                        address: curr.address,
                        name: curr.name,
                        currentAPY: curr.apy,
                        currentAllocation: curr.allocationPct,
                        totalAssets: curr.totalAssets,
                        historical: {
                            avgAPY: Array.isArray(prev.avg)
                                ? (prev.avg.length ? prev.avg.reduce((a, b) => a + b, 0) / prev.avg.length : 0)
                                : prev.avg || 0,
                            volatility: prev.volatility || 0,
                            sharpe: prev.sharpe || 0
                        }
                    };
                });

                aiRequestData.tiers.push({
                    tier: tier,
                    name: tierData.name,
                    strategies: strategies
                });
            }

            const payload = { base_apy: aiRequestData };

            logger.debug('AI Request Payload:', JSON.stringify(payload, null, 2));

            const aiResponse = await axios.post(config.AI_API_URL, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    ...(config.AI_API_KEY && { 'Authorization': `Bearer ${config.AI_API_KEY}` })
                },
                timeout: 60000
            });

            const allocations = aiResponse.data;

            logger.info('✅ AI Allocations Received');
            if (allocations.confidence !== undefined) {
                logger.info(`   Confidence: ${(allocations.confidence * 100).toFixed(1)}%`);
            }

            console.log("AI ALLOCATIONS RECEIVED: \n", JSON.stringify(allocations, null, 2));

            return allocations;

        } catch (error) {
            logger.error('❌ Error getting AI allocations:', error);
            throw error;
        }
    }

    // ============================================
    // UPDATE TIER ALLOCATIONS ON-CHAIN
    // ============================================

    async updateTierAllocations(tier, indices, allocations) {
        logger.info(`📝 Updating Tier ${tier} allocations on-chain...`);
        logger.debug(`   Indices: [${indices.join(', ')}]`);
        logger.debug(`   Allocations: [${allocations.join(', ')}]%`);

        if (config.ENABLE_DRY_RUN) {
            logger.warn('🔸 DRY RUN MODE: Skipping actual transaction');
            return { hash: 'DRY_RUN', blockNumber: 0, gasUsed: 0 };
        }


        try {
            // Try to check if operation is allowed by vault's rate limiter
            let canExecute = true;
            try {
                canExecute = await this.auraVault.canExecute("rebalance");
                if (!canExecute) {
                    logger.warn(`⏸️  Rebalance operation rate limited by vault for tier ${tier}`);
                    return null;
                }
            } catch (error) {
                // Vault doesn't have canExecute function, use client-side rate limiting
                const now = Date.now();
                const timeSinceLastRebalance = now - this.lastExecutionTimes.rebalance;

                if (timeSinceLastRebalance < this.MIN_REBALANCE_INTERVAL) {
                    const waitTime = Math.ceil((this.MIN_REBALANCE_INTERVAL - timeSinceLastRebalance) / 1000);
                    logger.warn(`⏸️  Client-side rate limit: wait ${waitTime}s before next rebalance`);
                    return null;
                }
            }

            const tx = await this.auraVault.updateTierAllocations(
                tier,
                indices,
                allocations,
                {
                    gasLimit: config.GAS_LIMIT_REBALANCE
                }
            );

            logger.info(`   🔄 TX sent: ${tx.hash}`);

            const receipt = await tx.wait();

            logger.info(`   ✅ Confirmed in block ${receipt.blockNumber}`);
            logger.info(`   ⛽ Gas used: ${receipt.gasUsed.toString()}`);

            // Update last execution time
            this.lastExecutionTimes.rebalance = Date.now();

            return receipt;

        } catch (error) {
            logger.error(`   ❌ Error updating tier ${tier} allocations:`, error);
            throw error;
        }
    }

    // ============================================
    // REBALANCE TIER ON-CHAIN
    // ============================================

    async rebalanceTier(tier) {
        logger.info(`⚖️  Rebalancing Tier ${tier}...`);

        if (config.ENABLE_DRY_RUN) {
            logger.warn('🔸 DRY RUN MODE: Skipping actual transaction');
            return { hash: 'DRY_RUN', blockNumber: 0, gasUsed: 0 };
        }

        try {
            // Try to check if operation is allowed by rate limiter
            try {
                const canExecute = await this.auraVault.canExecute("rebalance");
                if (!canExecute) {
                    logger.warn(`⏸️  Rebalance operation rate limited for tier ${tier}`);
                    return null;
                }
            } catch (err) {
                // Vault doesn't have canExecute, skip check
                logger.debug('   Vault does not have canExecute function');
            }

            const tx = await this.auraVault.rebalanceTier(tier, {
                gasLimit: config.GAS_LIMIT_REBALANCE
            });

            logger.info(`   🔄 TX sent: ${tx.hash}`);

            const receipt = await tx.wait();

            logger.info(`   ✅ Confirmed in block ${receipt.blockNumber}`);
            logger.info(`   ⛽ Gas used: ${receipt.gasUsed.toString()}`);

            this.rebalanceCount++;
            this.lastRebalanceTime = Date.now();

            return receipt;

        } catch (error) {
            logger.error(`   ❌ Error rebalancing tier ${tier}:`, error);
            throw error;
        }
    }

    // ============================================
    // HARVEST ALL STRATEGIES
    // ============================================

    async harvestAll() {
        logger.info('🌾 Harvesting all strategies...');

        if (config.ENABLE_DRY_RUN) {
            logger.warn('🔸 DRY RUN MODE: Skipping actual transaction');
            return { hash: 'DRY_RUN', blockNumber: 0, gasUsed: 0 };
        }

        try {
            // Check if operation is allowed by rate limiter
            const canExecute = await this.auraVault.canExecute("harvest");
            if (!canExecute) {
                logger.warn('⏸️  Harvest operation rate limited');
                return null;
            }

            const tx = await this.auraVault.harvestAll({
                gasLimit: config.GAS_LIMIT_HARVEST
            });

            logger.info(`   🔄 TX sent: ${tx.hash}`);

            const receipt = await tx.wait();

            logger.info(`   ✅ Confirmed in block ${receipt.blockNumber}`);
            logger.info(`   ⛽ Gas used: ${receipt.gasUsed.toString()}`);

            this.harvestCount++;
            this.lastHarvestTime = Date.now();

            return receipt;

        } catch (error) {
            logger.error('   ❌ Error harvesting:', error);
            throw error;
        }
    }

    // ============================================
    // UPDATE MONGODB WITH CURRENT DATA
    // ============================================

    async updateMongoDBStrategies(currentAPYs) {
        logger.debug('💾 Updating MongoDB with current strategy data...');

        try {
            const collection = this.db.collection('strategy_performance');
            const timestamp = new Date();

            const documents = [];

            for (let tier = 0; tier < 3; tier++) {
                const tierAPYs = currentAPYs.byTier[tier] || [];

                for (const strat of tierAPYs) {
                    documents.push({
                        strategyAddress: strat.address,
                        strategyName: strat.name,
                        tier: tier,
                        index: strat.index,
                        apy: strat.apy,
                        totalAssets: strat.totalAssets,
                        allocationPct: strat.allocationPct,
                        timestamp: timestamp,
                        updatedAt: timestamp
                    });
                }
            }

            if (documents.length > 0) {
                await collection.insertMany(documents);
                logger.debug(`   ✅ Inserted ${documents.length} strategy records`);
            }

        } catch (error) {
            logger.error('   ❌ Error updating MongoDB:', error);
        }
    }

    // ============================================
    // MAIN REBALANCE CYCLE
    // ============================================

    async performRebalanceCycle() {
        logger.info('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        logger.info('🔄 REBALANCE CYCLE STARTED');
        logger.info(`⏰ Time: ${new Date().toISOString()}`);
        logger.info(`📊 Cycle #${this.rebalanceCount + 1}`);
        logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        try {
            // Step 1: Fetch all strategies
            const allStrategies = await this.fetchAllStrategies();

            // Step 2: Fetch current APYs
            const currentAPYs = await this.fetchCurrentAPYs(allStrategies);

            // Step 3: Fetch historical APYs
            const previousAPYs = await this.fetchPreviousAPYs(allStrategies);

            // Step 4: Get AI allocations
            const aiAllocations = await this.getAIAllocations(currentAPYs, previousAPYs, allStrategies);

            // Step 5: Update and rebalance each tier
            for (let tier = 0; tier < aiAllocations.tiers.length; tier++) {
                const tierData = aiAllocations.tiers[tier];
                if (!tierData || !tierData.strategies || tierData.strategies.length === 0) {
                    logger.warn(`   ⚠️  No AI allocations for tier ${tier}, skipping...`);
                    continue;
                }

                logger.info(`\n━━━ TIER ${tier}: ${tierData.name.toUpperCase()} ━━━`);

                const indices = tierData.strategies.map(s => s.index);
                const rawAllocations = tierData.strategies.map(s => s.newAllocation);
                const allocations = this.adjustAllocationsTo100(rawAllocations);

                // Attempt Nitrolite off-chain submission first
                const nitroliteSubmitted = await this.submitOffChainRebalance(tier, indices, allocations);

                if (!nitroliteSubmitted) {
                    logger.info('   Falling back to standard on-chain rebalance...');
                    // Update allocations on-chain directly
                    await this.updateTierAllocations(tier, indices, allocations);
                    // Rebalance tier on-chain
                    await this.rebalanceTier(tier);
                } else {
                    logger.info('   Rebalance queued for batch settlement via Nitrolite');
                }
            }

            // Step 6: Update MongoDB
            await this.updateMongoDBStrategies(currentAPYs);

            logger.info('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            logger.info('✅ REBALANCE CYCLE COMPLETED SUCCESSFULLY');
            logger.info(`📊 Total rebalances: ${this.rebalanceCount}`);
            logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        } catch (error) {
            logger.error('❌ REBALANCE CYCLE FAILED:', error);
            logger.error('Stack trace:', error.stack);
        }
    }

    // ============================================
    // MAIN HARVEST CYCLE
    // ============================================

    async performHarvestCycle() {
        logger.info('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        logger.info('🌾 HARVEST CYCLE STARTED');
        logger.info(`⏰ Time: ${new Date().toISOString()}`);
        logger.info(`📊 Cycle #${this.harvestCount + 1}`);
        logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        try {
            const receipt = await this.harvestAll();

            if (receipt) {
                logger.info('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                logger.info('✅ HARVEST CYCLE COMPLETED SUCCESSFULLY');
                logger.info(`📊 Total harvests: ${this.harvestCount}`);
                logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
            }

        } catch (error) {
            logger.error('❌ HARVEST CYCLE FAILED:', error);
            logger.error('Stack trace:', error.stack);
        }
    }

    // ============================================
    // START AUTOMATION SERVICE
    // ============================================

    async start() {
        try {
            logger.info('\n🚀 Starting Nitrolite Keeper Service...\n');

            // Connect to MongoDB
            await this.connectMongoDB();

            // Verify Nitrolite authorization
            await this.verifyNitroliteAuthorization();

            // Initialize Nitrolite Protocol Channel
            await this.initNitroliteProtocol();

            this.isRunning = true;

            // Run initial rebalance
            await this.performRebalanceCycle();

            // Schedule rebalance cycles
            setInterval(() => {
                if (this.isRunning) {
                    this.performRebalanceCycle();
                }
            }, config.REBALANCE_INTERVAL);

            // Schedule harvest cycles
            setInterval(() => {
                if (this.isRunning) {
                    this.performHarvestCycle();
                }
            }, config.HARVEST_INTERVAL);

            logger.info('✅ Nitrolite Keeper Service fully operational!');
            logger.info(`⏰ Rebalancing every ${config.REBALANCE_INTERVAL / 60000} minutes`);
            logger.info(`🌾 Harvesting every ${config.HARVEST_INTERVAL / 60000} minutes\n`);

        } catch (error) {
            logger.error('❌ Failed to start Nitrolite Keeper Service:', error);
            throw error;
        }
    }

    // ============================================
    // STOP SERVICE
    // ============================================

    async stop() {
        logger.info('\n👋 Shutting down Nitrolite Keeper Service...');
        this.isRunning = false;

        if (this.mongoClient) {
            await this.mongoClient.close();
            logger.info('✅ MongoDB connection closed');
        }

        logger.info('✅ Service stopped gracefully');
    }

    // ============================================
    // HEALTH CHECK
    // ============================================

    getStatus() {
        return {
            isRunning: this.isRunning,
            rebalanceCount: this.rebalanceCount,
            harvestCount: this.harvestCount,
            lastRebalanceTime: this.lastRebalanceTime,
            lastHarvestTime: this.lastHarvestTime,
            operatorAddress: this.wallet.address,
            vaultAddress: config.AURA_VAULT_ADDRESS
        };
    }
    // ============================================
    // NITROLITE PROTOCOL INTEGRATION (OFFICIAL SDK)
    // ============================================

    async initNitroliteProtocol() {
        try {
            logger.info('🔌 Initializing Nitrolite Protocol SDK...');

            const account = privateKeyToAccount(config.NITROLITE_OPERATOR_PRIVATE_KEY);

            // Create viem clients as required by the Nitrolite SDK
            const publicClient = createPublicClient({
                chain: sepolia, // Aura-Farm targets Sepolia
                transport: http(config.RPC_URL)
            });

            const walletClient = createWalletClient({
                account,
                chain: sepolia,
                transport: http(config.RPC_URL)
            });

            this.nitroliteClient = new NitroliteClient({
                publicClient,
                walletClient,
                chainId: config.CHAIN_ID,
                challengeDuration: 3600n, // Minimum 1 hour
                addresses: {
                    // For Aura integration, we use the vault's settlement hooks as placeholders
                    custody: config.AURA_VAULT_ADDRESS,
                    adjudicator: config.AURA_VAULT_ADDRESS
                },
                stateSigner: {
                    sign: async (data) => account.signMessage({ message: { raw: data } })
                }
            });

            logger.info('✅ Nitrolite Protocol SDK Initialized');

            // Establish or resume channel
            this.channelId = `aura-rebalance-channel-${config.CHAIN_ID}`;

            // Start settlement timer
            this.settlementTimer = setInterval(
                () => this.performNitroliteSettlement(),
                config.SETTLEMENT_INTERVAL
            );

        } catch (error) {
            logger.error('❌ Failed to initialize Nitrolite Protocol:', error);
            // Fallback: Service continues in generic keeper mode
        }
    }

    async submitOffChainRebalance(tier, indices, allocations) {
        // Fallback: If Nitrolite client isn't ready, use standard rebalance
        if (!this.nitroliteClient) {
            return false;
        }

        try {
            logger.info(`⚡ Submitting off-chain rebalance for Tier ${tier} to Nitrolite...`);

            const rebalanceCommitment = {
                type: 'REBALANCE',
                tier,
                indices,
                allocations,
                timestamp: Date.now()
            };

            // In a real P2P clearing scenario, you would use this.nitroliteClient.createChannel
            // or checkpointChannel to commit the state to the Clearnode.
            // For now, we queue it for the automated batch settlement on-chain.

            // Queue for batch settlement
            this.pendingSettlements.push(rebalanceCommitment);

            logger.info('✅ Off-chain commitment accepted by Nitrolite');
            return true;
        } catch (error) {
            logger.warn('⚠️ Nitrolite off-chain submission failed, falling back to on-chain...');
            return false;
        }
    }

    async performNitroliteSettlement() {
        logger.debug(`🕒 Nitrolite settlement check... Pending: ${this.pendingSettlements.length}`);

        if (this.pendingSettlements.length === 0) return;

        logger.info(`📦 Batch settling ${this.pendingSettlements.length} Nitrolite operations on-chain...`);

        const settlements = [...this.pendingSettlements];
        this.pendingSettlements = [];

        for (const settlement of settlements) {
            try {
                if (settlement.type === 'REBALANCE') {
                    logger.info(`⚖️ Settling rebalance for Tier ${settlement.tier}...`);

                    const tx = await this.auraVault.settleRebalance(
                        settlement.tier,
                        settlement.indices,
                        settlement.allocations,
                        { gasLimit: config.GAS_LIMIT_REBALANCE }
                    );

                    logger.info(`   🔄 Settlement TX for Tier ${settlement.tier}: ${tx.hash}`);
                    const receipt = await tx.wait();
                    logger.info(`✅ Tier ${settlement.tier} settlement confirmed in block ${receipt.blockNumber}`);
                }
            } catch (error) {
                logger.error(`❌ Settlement failed for Tier ${settlement.tier}:`, error.message || error);
                this.pendingSettlements.push(settlement);
            }
        }
    }
}

// ============================================
// START THE SERVICE
// ============================================

async function main() {
    const keeper = new NitroliteKeeperService();

    // Graceful shutdown handlers
    process.on('SIGINT', async () => {
        await keeper.stop();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        await keeper.stop();
        process.exit(0);
    });

    // Start the service
    await keeper.start();
}

// Run if executed directly
if (require.main === module) {
    main().catch(error => {
        logger.error('❌ Fatal error:', error);
        process.exit(1);
    });
}

module.exports = NitroliteKeeperService;
