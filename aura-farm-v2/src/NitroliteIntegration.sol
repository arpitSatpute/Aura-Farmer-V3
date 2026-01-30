// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title NitroliteIntegration
 * @notice Manages Nitrolite protocol integration for automated vault operations
 * @dev This contract whitelists Nitrolite operators and tracks automated operations
 */
contract NitroliteIntegration is Ownable {
    
    // Nitrolite operator addresses (can be multiple keepers)
    mapping(address => bool) public nitroliteOperators;
    
    // Track last execution times for rate limiting
    mapping(bytes32 => uint256) public lastExecution;
    
    // Minimum time between operations (prevents spam)
    uint256 public constant MIN_REBALANCE_INTERVAL = 10 minutes;
    uint256 public constant MIN_HARVEST_INTERVAL = 1 hours;
    
    // Events
    event NitroliteOperatorAdded(address indexed operator);
    event NitroliteOperatorRemoved(address indexed operator);
    event AutomatedOperationExecuted(
        string indexed operationType,
        address indexed executor,
        uint256 timestamp
    );
    
    constructor() Ownable(msg.sender) {}
    
    /**
     * @notice Add a Nitrolite operator address
     * @param operator Address to whitelist
     */
    function addNitroliteOperator(address operator) external onlyOwner {
        require(operator != address(0), "Invalid operator");
        require(!nitroliteOperators[operator], "Already operator");
        
        nitroliteOperators[operator] = true;
        emit NitroliteOperatorAdded(operator);
    }
    
    /**
     * @notice Remove a Nitrolite operator address
     * @param operator Address to remove
     */
    function removeNitroliteOperator(address operator) external onlyOwner {
        require(nitroliteOperators[operator], "Not an operator");
        
        nitroliteOperators[operator] = false;
        emit NitroliteOperatorRemoved(operator);
    }
    
    /**
     * @notice Check if address is authorized Nitrolite operator
     * @param operator Address to check
     */
    function isNitroliteOperator(address operator) public view returns (bool) {
        return nitroliteOperators[operator];
    }
    
    /**
     * @notice Check if operation can be executed (rate limiting)
     * @param operationType Type of operation (e.g., "rebalance", "harvest")
     */
    function canExecute(string memory operationType) public view returns (bool) {
        bytes32 opHash = keccak256(bytes(operationType));
        uint256 minInterval;
        
        if (keccak256(bytes(operationType)) == keccak256(bytes("rebalance"))) {
            minInterval = MIN_REBALANCE_INTERVAL;
        } else if (keccak256(bytes(operationType)) == keccak256(bytes("harvest"))) {
            minInterval = MIN_HARVEST_INTERVAL;
        } else {
            return true; // No rate limit for other operations
        }
        
        return block.timestamp >= lastExecution[opHash] + minInterval;
    }
    
    /**
     * @notice Record operation execution (called by vault)
     * @param operationType Type of operation executed
     */
    function recordExecution(string memory operationType) internal {
        bytes32 opHash = keccak256(bytes(operationType));
        lastExecution[opHash] = block.timestamp;
        
        emit AutomatedOperationExecuted(operationType, msg.sender, block.timestamp);
    }
    
    /**
     * @notice Modifier to restrict functions to Nitrolite operators or owner
     */
    modifier onlyNitroliteOrOwner() {
        require(
            nitroliteOperators[msg.sender] || msg.sender == owner(),
            "Not authorized"
        );
        _;
    }
    
    /**
     * @notice Modifier to check rate limiting
     */
    modifier rateLimited(string memory operationType) {
        require(canExecute(operationType), "Operation rate limited");
        recordExecution(operationType);
        _;
    }
}
