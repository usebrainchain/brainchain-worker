// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// buy-stake places this code at the worker's own address in an eth_call, never on chain, so 0x's transaction runs
// exactly as the worker would send it and what it spends and brings is read in the same call. eth_simulateV1 cannot
// stand in: on Robinhood Chain it fails routes whose pools read a price oracle, where eth_call does not.
//
// Built with: solc-0.8.28 --optimize --evm-version cancun --bin-runtime scripts/probe.sol

interface IERC20 {
    function balanceOf(address owner) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

contract SwapProbe {
    address constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    function probe(address sold, address bought, uint256 approval, address target, uint256 value, bytes calldata data)
        external
        returns (uint256 spent, uint256 gained)
    {
        uint256 soldBefore = held(sold);
        uint256 boughtBefore = held(bought);
        if (approval != 0) IERC20(sold).approve(target, approval);
        (bool ok, bytes memory reason) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
        spent = soldBefore - held(sold);
        gained = held(bought) - boughtBefore;
    }

    function held(address token) private view returns (uint256) {
        return token == NATIVE ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    receive() external payable {}
}
