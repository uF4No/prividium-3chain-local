// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

import {IERC7786Recipient} from "../../interop/IERC7786Recipient.sol";

contract TestInteropGreetingRecipient is IERC7786Recipient {
    string public message;

    function receiveMessage(
        bytes32, /* receiveId */
        bytes calldata, /* sender */
        bytes calldata payload
    ) external payable returns (bytes4) {
        message = abi.decode(payload, (string));
        return IERC7786Recipient.receiveMessage.selector;
    }
}
