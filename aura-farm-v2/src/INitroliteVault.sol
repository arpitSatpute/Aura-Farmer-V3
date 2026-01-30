// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title INitroliteVault
 * @notice Interface for vaults integrated with the Nitrolite Protocol
 */
interface INitroliteVault {
    /**
     * @notice Settle an off-chain rebalance operation on-chain
     * @param riskTier The tier that was rebalanced
     * @param indices Strategy indices to update
     * @param allocations New allocation percentages
     */
    function settleRebalance(
        uint8 riskTier,
        uint256[] calldata indices,
        uint8[] calldata allocations
    ) external;

    /**
     * @notice Standard Nitrolite settlement for deposits/withdrawals
     * @param user The user whose shares are being settled
     * @param amount The amount in shares (or assets, depending on implementation)
     * @param isWithdraw True for withdrawal, false for deposit
     */
    function settleTransfer(
        address user,
        uint256 amount,
        bool isWithdraw
    ) external;
}
