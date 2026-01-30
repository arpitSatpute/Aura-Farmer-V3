// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console2.sol";

import "../src/VirtualUSDT.sol";
import "../src/RiskNFT.sol";
import "../src/AuraVaultWithNitrolite.sol";

// Low-risk strategies
import "../src/strategies/low-risk/BTCStrategy.sol";
import "../src/strategies/low-risk/ETHStrategy.sol";
import "../src/strategies/low-risk/BlueChipStrategy.sol";

// Medium-risk strategies
import "../src/strategies/medium-risk/DeFiLendingStrategy.sol";
import "../src/strategies/medium-risk/AltcoinStakingStrategy.sol";

// High-risk strategies
import "../src/strategies/high-risk/LeveragedYieldStrategy.sol";
import "../src/strategies/high-risk/MemecoinFarmingStrategy.sol";

/**
 * @title DeployAuraWithNitrolite
 * @notice Enhanced deployment script for Aura Protocol with Nitrolite integration
 * @dev Deploys AuraVaultWithNitrolite and configures Nitrolite operator
 */
contract DeployAuraWithNitrolite is Script {
    VirtualUSDT public vUSDT;
    RiskNFT public riskNFT;
    AuraVaultWithNitrolite public vault;

    BTCStrategy public btc;
    ETHStrategy public eth;
    BlueChipStrategy public bluechip;
    DeFiLendingStrategy public defi;
    AltcoinStakingStrategy public alt;
    LeveragedYieldStrategy public lev;
    MemecoinFarmingStrategy public meme;

    address public deployer;
    address public feeRecipient;
    address public nitroliteOperator;

    uint256 constant TEST_YIELD_PERIOD = 360; // 6 minutes = 1 "year" of yield

    function run() external {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        deployer = vm.addr(privateKey);
        feeRecipient = deployer;

        // Get Nitrolite operator address from environment
        // This should be a DIFFERENT address from deployer for security
        uint256 nitroliteKey = vm.envOr("NITROLITE_OPERATOR_PRIVATE_KEY", privateKey);
        nitroliteOperator = vm.addr(nitroliteKey);

        vm.startBroadcast(privateKey);

        console2.log("=============================================");
        console2.log("Deploying Aura Protocol with Nitrolite");
        console2.log("TEST MODE - 6 minute yield periods");
        console2.log("=============================================");
        console2.log("Deployer:           ", deployer);
        console2.log("Fee Recipient:      ", feeRecipient);
        console2.log("Nitrolite Operator: ", nitroliteOperator);
        console2.log("=============================================\n");

        // ═══════════════════════════════════════════════════════════
        // STEP 1: Deploy Core Contracts
        // ═══════════════════════════════════════════════════════════

        console2.log("Step 1: Deploying core contracts...");
        
        vUSDT = new VirtualUSDT();
        console2.log("  [OK] VirtualUSDT:  ", address(vUSDT));

        riskNFT = new RiskNFT();
        console2.log("  [OK] RiskNFT:      ", address(riskNFT));

        // Deploy AuraVaultWithNitrolite (includes NitroliteIntegration)
        vault = new AuraVaultWithNitrolite(address(vUSDT), address(riskNFT), feeRecipient);
        console2.log("  [OK] AuraVault:    ", address(vault));

        // ═══════════════════════════════════════════════════════════
        // STEP 2: Deploy Strategies
        // ═══════════════════════════════════════════════════════════

        console2.log("\nStep 2: Deploying strategies...");
        
        btc = new BTCStrategy(IERC20(address(vUSDT)));
        console2.log("  [OK] BTC Strategy:         ", address(btc));
        
        eth = new ETHStrategy(IERC20(address(vUSDT)));
        console2.log("  [OK] ETH Strategy:         ", address(eth));
        
        bluechip = new BlueChipStrategy(IERC20(address(vUSDT)));
        console2.log("  [OK] BlueChip Strategy:    ", address(bluechip));
        
        defi = new DeFiLendingStrategy(IERC20(address(vUSDT)));
        console2.log("  [OK] DeFi Lending:         ", address(defi));
        
        alt = new AltcoinStakingStrategy(IERC20(address(vUSDT)));
        console2.log("  [OK] Altcoin Staking:      ", address(alt));
        
        lev = new LeveragedYieldStrategy(IERC20(address(vUSDT)));
        console2.log("  [OK] Leveraged Yield:      ", address(lev));
        
        meme = new MemecoinFarmingStrategy(IERC20(address(vUSDT)));
        console2.log("  [OK] Memecoin Farming:     ", address(meme));

        // ═══════════════════════════════════════════════════════════
        // STEP 3: Configure Strategies
        // ═══════════════════════════════════════════════════════════

        console2.log("\nStep 3: Configuring strategies...");

        address[] memory strats = new address[](7);
        strats[0] = address(btc);
        strats[1] = address(eth);
        strats[2] = address(bluechip);
        strats[3] = address(defi);
        strats[4] = address(alt);
        strats[5] = address(lev);
        strats[6] = address(meme);

        for (uint256 i = 0; i < strats.length; i++) {
            // Set vault
            (bool successVault,) = strats[i].call(
                abi.encodeWithSignature("setVault(address)", address(vault))
            );
            require(successVault, "setVault failed");

            // Set test yield period (6 minutes)
            (bool successPeriod,) = strats[i].call(
                abi.encodeWithSignature("setYieldPeriod(uint256)", TEST_YIELD_PERIOD)
            );
            require(successPeriod, "setYieldPeriod failed");

            // Add as minter to VirtualUSDT
            vUSDT.addMinter(strats[i]);
        }
        console2.log("  [OK] All strategies configured");

        // ═══════════════════════════════════════════════════════════
        // STEP 4: Add Strategies to Vault Tiers
        // ═══════════════════════════════════════════════════════════

        console2.log("\nStep 4: Adding strategies to vault tiers...");

        // Tier 0: Low Risk (100% total)
        vault.addStrategy(0, address(btc), 40);
        vault.addStrategy(0, address(eth), 40);
        vault.addStrategy(0, address(bluechip), 20);
        console2.log("  [OK] Tier 0 (Low Risk): 40% BTC, 40% ETH, 20% BlueChip");

        // Tier 1: Medium Risk (100% total)
        vault.addStrategy(1, address(defi), 60);
        vault.addStrategy(1, address(alt), 40);
        console2.log("  [OK] Tier 1 (Medium Risk): 60% DeFi, 40% Altcoin");

        // Tier 2: High Risk (100% total)
        vault.addStrategy(2, address(lev), 60);
        vault.addStrategy(2, address(meme), 40);
        console2.log("  [OK] Tier 2 (High Risk): 60% Leveraged, 40% Memecoin");

        // ═══════════════════════════════════════════════════════════
        // STEP 5: Configure Nitrolite Integration
        // ═══════════════════════════════════════════════════════════

        console2.log("\nStep 5: Configuring Nitrolite integration...");

        // Add Nitrolite operator
        vault.addNitroliteOperator(nitroliteOperator);
        console2.log("  [OK] Nitrolite operator authorized:", nitroliteOperator);

        // Verify authorization
        bool isAuthorized = vault.isNitroliteOperator(nitroliteOperator);
        require(isAuthorized, "Nitrolite operator not authorized");
        console2.log("  [OK] Authorization verified");

        vm.stopBroadcast();

        // ═══════════════════════════════════════════════════════════
        // DEPLOYMENT SUMMARY
        // ═══════════════════════════════════════════════════════════

        console2.log("\n=============================================");
        console2.log("DEPLOYMENT SUCCESSFUL!");
        console2.log("=============================================\n");

        console2.log("Core Contracts:");
        console2.log("  VirtualUSDT:       ", address(vUSDT));
        console2.log("  RiskNFT:           ", address(riskNFT));
        console2.log("  AuraVault:         ", address(vault));
        console2.log("  Fee Recipient:     ", feeRecipient);

        console2.log("\nLow Risk Strategies (Tier 0):");
        console2.log("  BTC (40%):         ", address(btc));
        console2.log("  ETH (40%):         ", address(eth));
        console2.log("  BlueChip (20%):    ", address(bluechip));

        console2.log("\nMedium Risk Strategies (Tier 1):");
        console2.log("  DeFi Lending (60%):", address(defi));
        console2.log("  Altcoin (40%):     ", address(alt));

        console2.log("\nHigh Risk Strategies (Tier 2):");
        console2.log("  Leveraged (60%):   ", address(lev));
        console2.log("  Memecoin (40%):    ", address(meme));

        console2.log("\nNitrolite Configuration:");
        console2.log("  Operator Address:  ", nitroliteOperator);
        console2.log("  Is Authorized:     ", isAuthorized ? "YES" : "NO");

        console2.log("\n=============================================");
        console2.log("NEXT STEPS:");
        console2.log("=============================================");
        console2.log("1. Update .env files with deployed addresses");
        console2.log("2. Start MongoDB service");
        console2.log("3. Start Nitrolite keeper service");
        console2.log("4. Monitor keeper logs for authorization");
        console2.log("=============================================\n");

        // ═══════════════════════════════════════════════════════════
        // ENVIRONMENT FILE TEMPLATE
        // ═══════════════════════════════════════════════════════════

        console2.log("\n.env Configuration Template:");
        console2.log("---------------------------------------------");
        console2.log("VIRTUAL_USDT_ADDRESS=%s", address(vUSDT));
        console2.log("RISK_NFT_ADDRESS=%s", address(riskNFT));
        console2.log("AURA_VAULT_ADDRESS=%s", address(vault));
        console2.log("FEE_RECIPIENT_ADDRESS=%s", feeRecipient);
        console2.log("\n# Strategies - Low Risk (Tier 0)");
        console2.log("STRATEGY_BTC_ADDRESS=%s", address(btc));
        console2.log("STRATEGY_ETH_ADDRESS=%s", address(eth));
        console2.log("STRATEGY_BLUECHIP_ADDRESS=%s", address(bluechip));
        console2.log("\n# Strategies - Medium Risk (Tier 1)");
        console2.log("STRATEGY_DEFILENDING_ADDRESS=%s", address(defi));
        console2.log("STRATEGY_ALTCOINSTAKING_ADDRESS=%s", address(alt));
        console2.log("\n# Strategies - High Risk (Tier 2)");
        console2.log("STRATEGY_LEVERAGEDYIELD_ADDRESS=%s", address(lev));
        console2.log("STRATEGY_MEMECOINFARMING_ADDRESS=%s", address(meme));
        console2.log("---------------------------------------------\n");
    }
}
