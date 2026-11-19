// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * StudentGroupVaultV2 - quỹ chung riêng cho từng nhóm + niêm phong hóa đơn.
 *
 * - Mỗi nhóm (groupId là chuỗi lấy từ Supabase) có số dư riêng.
 * - "Thành viên quỹ" = ví đã góp tối thiểu MIN_CONTRIBUTION cho nhóm đó.
 * - Yêu cầu rút quỹ cần đa số thành viên quỹ (tính tại thời điểm tạo yêu cầu) đồng ý
 *   thì tiền mới được chuyển đến người nhận.
 * - sealReceipt chỉ ghi mã hash hóa đơn lên chain, KHÔNG liên quan đến tiền.
 * - Không có hàm hoàn tiền/rút tự do: tiền chỉ ra khỏi quỹ qua yêu cầu đã được duyệt.
 *
 * Triển khai: Remix, compiler 0.8.20 trở lên, không có tham số constructor.
 */
contract StudentGroupVaultV2 {
    uint256 public constant MIN_CONTRIBUTION = 0.01 ether;
    uint256 private constant MAX_ID_LEN = 64;
    uint256 private constant MAX_DESC_LEN = 280;
    uint256 private constant MAX_HASH_LEN = 128;

    // Thứ tự trường phải khớp với ABI_V2 trong avalanche-bridge.js
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

    mapping(bytes32 => uint256) private groupBalances;
    mapping(bytes32 => uint256) private contributorCount;
    mapping(bytes32 => uint256[]) private groupRequestIds;
    mapping(bytes32 => mapping(address => uint256)) private contributions;
    mapping(bytes32 => bool) private sealedHashes;

    mapping(uint256 => uint256) public requiredApprovals;
    mapping(uint256 => mapping(address => bool)) public hasApproved;

    event Deposited(string groupId, address indexed from, uint256 amount);
    event RequestCreated(uint256 indexed id, string groupId, address indexed creator, uint256 amount, address recipient);
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

    // ------------------------------------------------------------------ helpers
    function _key(string memory groupId) private pure returns (bytes32) {
        return keccak256(bytes(groupId));
    }

    function _isContributor(bytes32 k, address who) private view returns (bool) {
        return contributions[k][who] >= MIN_CONTRIBUTION;
    }

    function _checkLen(uint256 len, uint256 max, string memory what) private pure {
        require(len > 0 && len <= max, what);
    }

    // ------------------------------------------------------------------ views
    function getGroupBalance(string calldata _groupId) external view returns (uint256) {
        return groupBalances[_key(_groupId)];
    }

    function getGroupRequestIds(string calldata _groupId) external view returns (uint256[] memory) {
        return groupRequestIds[_key(_groupId)];
    }

    function getRequestsCount() external view returns (uint256) {
        return requests.length;
    }

    function getSealsCount() external view returns (uint256) {
        return seals.length;
    }

    function getContributorCount(string calldata _groupId) external view returns (uint256) {
        return contributorCount[_key(_groupId)];
    }

    function getContribution(string calldata _groupId, address _who) external view returns (uint256) {
        return contributions[_key(_groupId)][_who];
    }

    function isContributor(string calldata _groupId, address _who) external view returns (bool) {
        return _isContributor(_key(_groupId), _who);
    }

    function verifyReceipt(uint256 _requestId, string calldata _hashToCheck) external view returns (bool) {
        if (_requestId >= requests.length) return false;
        return keccak256(bytes(requests[_requestId].receiptHash)) == keccak256(bytes(_hashToCheck));
    }

    function verifySeal(uint256 _sealId, string calldata _hashToCheck) external view returns (bool) {
        if (_sealId >= seals.length) return false;
        return keccak256(bytes(seals[_sealId].receiptHash)) == keccak256(bytes(_hashToCheck));
    }

    // ------------------------------------------------------------------ quỹ
    function deposit(string calldata _groupId) external payable {
        _checkLen(bytes(_groupId).length, MAX_ID_LEN, "Bad groupId");
        require(msg.value > 0, "No value");
        bytes32 k = _key(_groupId);

        bool wasContributor = _isContributor(k, msg.sender);
        contributions[k][msg.sender] += msg.value;
        groupBalances[k] += msg.value;
        if (!wasContributor && _isContributor(k, msg.sender)) {
            contributorCount[k] += 1;
        }
        emit Deposited(_groupId, msg.sender, msg.value);
    }

    function createExpenseRequest(
        string calldata _groupId,
        string calldata _description,
        uint256 _amount,
        address payable _recipient,
        string calldata _receiptHash
    ) external returns (uint256 id) {
        _checkLen(bytes(_groupId).length, MAX_ID_LEN, "Bad groupId");
        _checkLen(bytes(_description).length, MAX_DESC_LEN, "Bad description");
        _checkLen(bytes(_receiptHash).length, MAX_HASH_LEN, "Bad receiptHash");
        require(_recipient != address(0), "Bad recipient");

        bytes32 k = _key(_groupId);
        require(_isContributor(k, msg.sender), "Not a contributor");
        require(_amount > 0 && _amount <= groupBalances[k], "Bad amount");

        id = requests.length;
        Request storage r = requests.push();
        r.id = id;
        r.groupId = _groupId;
        r.description = _description;
        r.amount = _amount;
        r.recipient = _recipient;
        r.receiptHash = _receiptHash;
        r.creator = msg.sender;

        groupRequestIds[k].push(id);
        requiredApprovals[id] = contributorCount[k] / 2 + 1; // đa số

        emit RequestCreated(id, _groupId, msg.sender, _amount, _recipient);
    }

    function approveRequest(uint256 _requestId) external nonReentrant {
        require(_requestId < requests.length, "No request");
        Request storage r = requests[_requestId];
        require(!r.executed, "Already executed");

        bytes32 k = _key(r.groupId);
        require(_isContributor(k, msg.sender), "Not a contributor");
        require(!hasApproved[_requestId][msg.sender], "Already approved");

        hasApproved[_requestId][msg.sender] = true;
        r.approvalCount += 1;
        emit Approved(_requestId, msg.sender, r.approvalCount);

        if (r.approvalCount >= requiredApprovals[_requestId] && groupBalances[k] >= r.amount) {
            _execute(r, k);
        }
    }

    // Dùng khi đủ phiếu duyệt nhưng lúc đó quỹ chưa đủ tiền
    function executeRequest(uint256 _requestId) external nonReentrant {
        require(_requestId < requests.length, "No request");
        Request storage r = requests[_requestId];
        require(!r.executed, "Already executed");
        require(r.approvalCount >= requiredApprovals[_requestId], "Not enough approvals");
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

    // ------------------------------------------------------------------ niêm phong (không liên quan đến tiền)
    function sealReceipt(string calldata _groupId, string calldata _receiptHash) external returns (uint256 sealId) {
        _checkLen(bytes(_groupId).length, MAX_ID_LEN, "Bad groupId");
        _checkLen(bytes(_receiptHash).length, MAX_HASH_LEN, "Bad receiptHash");
        require(_isContributor(_key(_groupId), msg.sender), "Not a contributor");

        bytes32 sk = keccak256(abi.encode(_groupId, _receiptHash));
        require(!sealedHashes[sk], "Already sealed");
        sealedHashes[sk] = true;

        sealId = seals.length;
        Seal storage s = seals.push();
        s.groupId = _groupId;
        s.receiptHash = _receiptHash;
        s.sealedBy = msg.sender;
        s.sealedAt = block.timestamp;

        emit ReceiptSealed(sealId, _groupId, _receiptHash, msg.sender);
    }
}
