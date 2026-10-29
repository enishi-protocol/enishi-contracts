// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockV2Factory {
    mapping(address => mapping(address => address)) private _pairs;

    function setPair(address a, address b, address pair) external {
        _pairs[a][b] = pair;
        _pairs[b][a] = pair;
    }

    function getPair(address a, address b) external view returns (address) {
        return _pairs[a][b];
    }
}
