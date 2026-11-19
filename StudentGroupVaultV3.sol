// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * StudentGroupVaultV3
 *
 * V3 closes two V2 gaps:
 * - A group is registered with an EIP-191 signature from its stated owner;
 *   only wallets on that signed member list may join the vault.
 * - Each reimbursement request carries a unique expenseKey per group, so the
 *   same app expense cannot be requested twice through this contract.
 *
 * The owner must sign the raw 32-byte value returned by registrationDigest()
 * using personal_sign / ethers signer.signMessage(getBytes(digest)).
 * Membership changes are append-only for wallets that have already contributed.
 */
contract StudentGroupVaultV3 {
    uint256 public constant MIN_CONTRIBUTION = 0.01 ether;
    uint256 private constant MAX_ID_LEN = 64;
    uint256 private constant MAX_DESC_LEN = 280;
    uint256 private constant MAX_HASH_LEN = 128;

    struct Request {
        uint256 id;
        string groupId;
        string description;
        uint256 amount;
        address payable recipient;
        string receiptHash;
        uint256 approvalCount;
        bool executed;
        address creator;
    }

    struct Seal {
        string groupId;
        string receiptHash;
        address sealedBy;
        uint256 sealedAt;
    }

    Request[] public requests;
    Seal[] public seals;

    mapping(bytes32 => address) public groupOwner;
    mapping(bytes32 => mapping(address => bool)) public isGroupMember;
    mapping(bytes32 => uint256) private groupBalances;
    mapping(bytes32 => uint256) private contributorCount;
    mapping(bytes32 => uint256[]) private groupRequestIds;
    mapping(bytes32 => mapping(address => uint256)) private contributions;
    mapping(bytes32 => mapping(bytes32 => bool)) public expenseKeyUsed;
    mapping(bytes32 => bool) private sealedHashes;
    mapping(uint256 => uint256) public requiredApprovals;
    mapping(uint256 => mapping(address => bool)) public hasApproved;

    event GroupRegistered(string groupId, address indexed owner);
    event GroupMemberUpdated(string groupId, address indexed member, bool allowed);
    event Deposited(string groupId, address indexed from, uint256 amount);
    event RequestCreated(uint256 indexed id, string groupId, bytes32 indexed expenseKey, address indexed creator, uint256 amount, address recipient);
    event Approved(uint256 indexed id, address indexed approver, uint256 approvalCount);
    event Executed(uint256 indexed id, address indexed recipient, uint256 amount);
    event ReceiptSealed(uint256 indexed sealId, string groupId, string receiptHash, address indexed sealedBy);

    bool private locked;
    modifier nonReentrant() {
        require(!locked, "Reentrant");
        locked = true;
        _;
        locked = false;
    }

    function _key(string memory groupId) private pure returns (bytes32) {
        return keccak256(bytes(groupId));
    }

    function _isContributor(bytes32 k, address who) private view returns (bool) {
        return isGroupMember[k][who] && contributions[k][who] >= MIN_CONTRIBUTION;
    }

    function _checkLen(uint256 len, uint256 max, string memory what) private pure {
        require(len > 0 && len <= max, what);
    }

    function registrationDigest(string calldata groupId, address owner, address[] memory members) public view returns (bytes32) {
        bytes32 membersHash = keccak256(abi.encode(members));
        return keccak256(abi.encode(address(this), block.chainid, keccak256(bytes(groupId)), owner, membersHash));
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        require(signature.length == 65, "Bad signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "Bad signature v");
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        signer = ecrecover(ethSigned, v, r, s);
        require(signer != address(0), "Bad signature");
    }

    function registerGroup(string calldata groupId, address owner, address[] calldata members, bytes calldata signature) external {
        _checkLen(bytes(groupId).length, MAX_ID_LEN, "Bad groupId");
        require(owner != address(0) && members.length > 0 && members.length <= 100, "Bad members");
        bytes32 k = _key(groupId);
        require(groupOwner[k] == address(0), "Group already registered");
        require(_recover(registrationDigest(groupId, owner, members), signature) == owner, "Owner signature required");

        bool ownerIncluded;
        groupOwner[k] = owner;
        for (uint256 i; i < members.length; ++i) {
            address member = members[i];
            require(member != address(0), "Bad member");
            isGroupMember[k][member] = true;
            if (member == owner) ownerIncluded = true;
        }
        require(ownerIncluded, "Owner must be a member");
        emit GroupRegistered(groupId, owner);
    }

    function setGroupMember(string calldata groupId, address member, bool allowed) external {
        bytes32 k = _key(groupId);
        require(msg.sender == groupOwner[k], "Only group owner");
        require(member != address(0), "Bad member");
        if (!allowed) require(contributions[k][member] == 0, "Cannot remove contributor");
        isGroupMember[k][member] = allowed;
        emit GroupMemberUpdated(groupId, member, allowed);
    }

    function getGroupBalance(string calldata groupId) external view returns (uint256) { return groupBalances[_key(groupId)]; }
    function getGroupRequestIds(string calldata groupId) external view returns (uint256[] memory) { return groupRequestIds[_key(groupId)]; }
    function getRequestsCount() external view returns (uint256) { return requests.length; }
    function getSealsCount() external view returns (uint256) { return seals.length; }
    function getContributorCount(string calldata groupId) external view returns (uint256) { return contributorCount[_key(groupId)]; }
    function getContribution(string calldata groupId, address who) external view returns (uint256) { return contributions[_key(groupId)][who]; }
    function isContributor(string calldata groupId, address who) external view returns (bool) { return _isContributor(_key(groupId), who); }

    function verifyReceipt(uint256 requestId, string calldata hashToCheck) external view returns (bool) {
        if (requestId >= requests.length) return false;
        return keccak256(bytes(requests[requestId].receiptHash)) == keccak256(bytes(hashToCheck));
    }

    function verifySeal(uint256 sealId, string calldata hashToCheck) external view returns (bool) {
        if (sealId >= seals.length) return false;
        return keccak256(bytes(seals[sealId].receiptHash)) == keccak256(bytes(hashToCheck));
    }

    function deposit(string calldata groupId) external payable {
        _checkLen(bytes(groupId).length, MAX_ID_LEN, "Bad groupId");
        require(isGroupMember[_key(groupId)][msg.sender], "Not a group member");
        require(msg.value > 0, "No value");
        bytes32 k = _key(groupId);
        bool wasContributor = _isContributor(k, msg.sender);
        contributions[k][msg.sender] += msg.value;
        groupBalances[k] += msg.value;
        if (!wasContributor && _isContributor(k, msg.sender)) contributorCount[k] += 1;
        emit Deposited(groupId, msg.sender, msg.value);
    }

    function createExpenseRequest(
        string calldata groupId,
        bytes32 expenseKey,
        string calldata description,
        uint256 amount,
        address payable recipient,
        string calldata receiptHash
    ) external returns (uint256 id) {
        _checkLen(bytes(groupId).length, MAX_ID_LEN, "Bad groupId");
        _checkLen(bytes(description).length, MAX_DESC_LEN, "Bad description");
        _checkLen(bytes(receiptHash).length, MAX_HASH_LEN, "Bad receiptHash");
        require(expenseKey != bytes32(0) && recipient != address(0), "Bad request");
        bytes32 k = _key(groupId);
        require(_isContributor(k, msg.sender), "Not a contributor");
        require(!expenseKeyUsed[k][expenseKey], "Expense already requested");
        require(amount > 0 && amount <= groupBalances[k], "Bad amount");
        expenseKeyUsed[k][expenseKey] = true;

        id = requests.length;
        Request storage r = requests.push();
        r.id = id;
        r.groupId = groupId;
        r.description = description;
        r.amount = amount;
        r.recipient = recipient;
        r.receiptHash = receiptHash;
        r.creator = msg.sender;
        groupRequestIds[k].push(id);
        requiredApprovals[id] = contributorCount[k] / 2 + 1;
        emit RequestCreated(id, groupId, expenseKey, msg.sender, amount, recipient);
    }

    function approveRequest(uint256 requestId) external nonReentrant {
        require(requestId < requests.length, "No request");
        Request storage r = requests[requestId];
        require(!r.executed, "Already executed");
        bytes32 k = _key(r.groupId);
        require(_isContributor(k, msg.sender), "Not a contributor");
        require(!hasApproved[requestId][msg.sender], "Already approved");
        hasApproved[requestId][msg.sender] = true;
        r.approvalCount += 1;
        emit Approved(requestId, msg.sender, r.approvalCount);
        if (r.approvalCount >= requiredApprovals[requestId] && groupBalances[k] >= r.amount) _execute(r, k);
    }

    function executeRequest(uint256 requestId) external nonReentrant {
        require(requestId < requests.length, "No request");
        Request storage r = requests[requestId];
        require(!r.executed, "Already executed");
        require(r.approvalCount >= requiredApprovals[requestId], "Not enough approvals");
        bytes32 k = _key(r.groupId);
        require(groupBalances[k] >= r.amount, "Insufficient balance");
        _execute(r, k);
    }

    function _execute(Request storage r, bytes32 k) private {
        r.executed = true;
        groupBalances[k] -= r.amount;
        (bool ok, ) = r.recipient.call{value: r.amount}("");
        require(ok, "Transfer failed");
        emit Executed(r.id, r.recipient, r.amount);
    }

    function sealReceipt(string calldata groupId, string calldata receiptHash) external returns (uint256 sealId) {
        _checkLen(bytes(groupId).length, MAX_ID_LEN, "Bad groupId");
        _checkLen(bytes(receiptHash).length, MAX_HASH_LEN, "Bad receiptHash");
        require(_isContributor(_key(groupId), msg.sender), "Not a contributor");
        bytes32 sk = keccak256(abi.encode(groupId, receiptHash));
        require(!sealedHashes[sk], "Already sealed");
        sealedHashes[sk] = true;
        sealId = seals.length;
        Seal storage s = seals.push();
        s.groupId = groupId;
        s.receiptHash = receiptHash;
        s.sealedBy = msg.sender;
        s.sealedAt = block.timestamp;
        emit ReceiptSealed(sealId, groupId, receiptHash, msg.sender);
    }
}
