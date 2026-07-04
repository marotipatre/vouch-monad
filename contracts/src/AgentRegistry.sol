// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./IERC20.sol";

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4 magicValue);
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

/// ERC-8004-style agent registry for Monad.
///
/// This contract keeps the repo's existing demo flow intact while upgrading the
/// registry surface to the ERC-8004 identity + reputation model:
///   - each agent is an ERC-721 token with URI storage
///   - optional on-chain metadata is keyed by string
///   - agentWallet is a reserved metadata field with signature-gated updates
///   - feedback is recorded on-chain with immutable events and readable summaries
///
/// The existing bond / resolver hooks are preserved so `Insurance` and `Resolver`
/// continue to work without a repo-wide rewrite.
contract AgentRegistry {
    uint256 public constant MIN_BOND = 1_000_000;
    bytes4 private constant _ERC721_INTERFACE_ID = 0x80ac58cd;
    bytes4 private constant _ERC721_METADATA_INTERFACE_ID = 0x5b5e139f;
    bytes4 private constant _ERC165_INTERFACE_ID = 0x01ffc9a7;
    bytes4 private constant _ERC1271_MAGICVALUE = 0x1626ba7e;
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _SET_AGENT_WALLET_TYPEHASH =
        keccak256("SetAgentWallet(uint256 agentId,address newWallet,uint256 deadline)");
    bytes32 private constant _AGENT_WALLET_KEY = keccak256(bytes("agentWallet"));

    string public constant name = "Monad Agent Registry";
    string public constant symbol = "AGENT";

    struct Agent {
        address owner;
        string name;
        string taskClass;
        bool isAuditor;
        uint256 bond;
        uint256 reliabilityBps;
        uint256 jobsTotal;
        uint256 jobsFailed;
        bool exists;
    }

    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    struct Feedback {
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        bool isRevoked;
    }

    IERC20 public immutable usdc;
    address public admin;
    address public resolver;

    uint256 public agentCount;
    mapping(uint256 => Agent) private agents;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;
    mapping(uint256 => string) private _tokenURIs;
    mapping(uint256 => mapping(bytes32 => bytes)) private _metadata;
    mapping(uint256 => address) private _agentWallet;

    mapping(uint256 => mapping(address => uint64)) private _lastFeedbackIndex;
    mapping(uint256 => address[]) private _clientsByAgent;
    mapping(uint256 => mapping(address => bool)) private _clientSeen;
    mapping(uint256 => mapping(address => mapping(uint64 => Feedback))) private _feedbacks;
    mapping(uint256 => mapping(address => mapping(uint64 => uint64))) private _responseTotals;
    mapping(uint256 => mapping(address => mapping(uint64 => mapping(address => uint64)))) private _responseByResponder;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue);
    event AgentWalletSet(uint256 indexed agentId, address indexed wallet, address indexed updatedBy);
    event AgentWalletUnset(uint256 indexed agentId, address indexed updatedBy);

    event AgentRegistered(
        uint256 indexed agentId,
        address indexed owner,
        string taskClass,
        bool isAuditor,
        uint256 bond,
        uint256 reliabilityBps
    );
    event BondSlashed(uint256 indexed agentId, uint256 amount, uint256 remaining);
    event JobRecorded(uint256 indexed agentId, bool failed, uint256 newReliabilityBps);
    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);
    event ResponseAppended(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 indexed feedbackIndex,
        address responder,
        string responseURI,
        bytes32 responseHash
    );
    event ResolverSet(address resolver);

    error BondTooLow();
    error NotOwner();
    error NotApproved();
    error NotAdmin();
    error NotResolver();
    error NoAgent();
    error NoClient();
    error NoFeedback();
    error AlreadyExists();
    error InvalidAddress();
    error InvalidValueDecimals();
    error InvalidSignature();
    error SignatureExpired();
    error MetadataKeyReserved();

    constructor(IERC20 _usdc) {
        usdc = _usdc;
        admin = msg.sender;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyResolver() {
        if (msg.sender != resolver) revert NotResolver();
        _;
    }

    /// One-time wiring: the admin points the registry at the Resolver contract.
    function setResolver(address _resolver) external onlyAdmin {
        resolver = _resolver;
        emit ResolverSet(_resolver);
    }

    /// ERC-8004 identity registration with metadata.
    function register(string calldata agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId) {
        agentId = _mintIdentity(msg.sender, agentURI);
        _setAgentDefaults(agentId, msg.sender, "", "", false, 0, 10_000);
        _emitRegistration(agentId, agentURI, msg.sender);
        _applyMetadata(agentId, metadata);
    }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = _mintIdentity(msg.sender, agentURI);
        _setAgentDefaults(agentId, msg.sender, "", "", false, 0, 10_000);
        _emitRegistration(agentId, agentURI, msg.sender);
    }

    function register() external returns (uint256 agentId) {
        agentId = _mintIdentity(msg.sender, "");
        _setAgentDefaults(agentId, msg.sender, "", "", false, 0, 10_000);
        _emitRegistration(agentId, "", msg.sender);
    }

    /// Compatibility wrapper for the existing Monad demo flow: worker agent + bond.
    function registerAgent(string calldata name_, string calldata taskClass_, uint256 bond)
        external
        returns (uint256 agentId)
    {
        if (bond < MIN_BOND) revert BondTooLow();
        require(usdc.transferFrom(msg.sender, address(this), bond), "bond transfer failed");
        agentId = _mintIdentity(msg.sender, "");
        _setAgentDefaults(agentId, msg.sender, name_, taskClass_, false, bond, 9000);
        _emitRegistration(agentId, "", msg.sender);
        emit AgentRegistered(agentId, msg.sender, taskClass_, false, bond, 9000);
    }

    /// Compatibility wrapper: admin-gated auditor registration with bond.
    function registerAuditor(string calldata name_, address operator, uint256 bond)
        external
        onlyAdmin
        returns (uint256 agentId)
    {
        if (operator == address(0)) revert InvalidAddress();
        if (bond < MIN_BOND) revert BondTooLow();
        require(usdc.transferFrom(msg.sender, address(this), bond), "bond transfer failed");
        agentId = _mintIdentity(operator, "");
        _setAgentDefaults(agentId, operator, name_, "*", true, bond, 10_000);
        _emitRegistration(agentId, "", operator);
        emit AgentRegistered(agentId, operator, "*", true, bond, 10_000);
    }

    /// Owner adds more bond.
    function topUpBond(uint256 agentId, uint256 more) external {
        Agent storage a = agents[agentId];
        if (!a.exists) revert NoAgent();
        if (msg.sender != a.owner) revert NotOwner();
        require(usdc.transferFrom(msg.sender, address(this), more), "bond transfer failed");
        a.bond += more;
    }

    function approve(address to, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        if (msg.sender != owner && !isApprovedForAll(owner, msg.sender)) revert NotOwner();
        _tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function getApproved(uint256 tokenId) public view returns (address) {
        if (!_exists(tokenId)) revert NoAgent();
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) public view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, bytes("") );
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        _transfer(from, to, tokenId);
        if (to.code.length != 0) {
            bytes4 response = IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data);
            require(response == IERC721Receiver.onERC721Received.selector, "ERC721: receiver rejected tokens");
        }
    }

    /// Owner adds / updates the token URI.
    function setAgentURI(uint256 agentId, string calldata newURI) external {
        if (!_isApprovedOrOwner(msg.sender, agentId)) revert NotApproved();
        _requireAgent(agentId);
        _tokenURIs[agentId] = newURI;
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    /// Read the ERC-721 token URI.
    function tokenURI(uint256 agentId) external view returns (string memory) {
        _requireAgent(agentId);
        return _tokenURIs[agentId];
    }

    /// ERC-8004 metadata: arbitrary on-chain bytes keyed by a string.
    function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue) external {
        if (keccak256(bytes(metadataKey)) == _AGENT_WALLET_KEY) revert MetadataKeyReserved();
        if (!_isApprovedOrOwner(msg.sender, agentId)) revert NotApproved();
        _requireAgent(agentId);
        _setMetadata(agentId, metadataKey, metadataValue);
    }

    function getMetadata(uint256 agentId, string calldata metadataKey) external view returns (bytes memory) {
        _requireAgent(agentId);
        return _metadata[agentId][keccak256(bytes(metadataKey))];
    }

    /// Set the agent wallet with an owner signature or a direct owner call.
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
        external
    {
        address owner = ownerOf(agentId);
        if (newWallet == address(0)) revert InvalidAddress();
        if (msg.sender != owner) {
            if (block.timestamp > deadline) revert SignatureExpired();
            bytes32 structHash = keccak256(abi.encode(_SET_AGENT_WALLET_TYPEHASH, agentId, newWallet, deadline));
            bytes32 digest = _hashTypedData(structHash);
            if (!_isValidSignatureNow(owner, digest, signature)) revert InvalidSignature();
        }

        _agentWallet[agentId] = newWallet;
        _setReservedMetadata(agentId, abi.encode(newWallet));
        emit AgentWalletSet(agentId, newWallet, msg.sender);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        _requireAgent(agentId);
        return _agentWallet[agentId];
    }

    function unsetAgentWallet(uint256 agentId) external {
        if (!_isApprovedOrOwner(msg.sender, agentId)) revert NotApproved();
        _requireAgent(agentId);
        _agentWallet[agentId] = address(0);
        _setReservedMetadata(agentId, bytes(""));
        emit AgentWalletUnset(agentId, msg.sender);
    }

    // ---- resolver-gated mutations (called by Resolver during settlement) ----

    /// Slash up to `amount` from the bond and send it to `to` (the reserve).
    function slashBond(uint256 agentId, uint256 amount, address to) external onlyResolver returns (uint256 taken) {
        Agent storage a = agents[agentId];
        if (!a.exists) revert NoAgent();
        taken = amount > a.bond ? a.bond : amount;
        a.bond -= taken;
        if (taken > 0) require(usdc.transfer(to, taken), "slash transfer failed");
        emit BondSlashed(agentId, taken, a.bond);
    }

    /// Record a completed job and refresh cached reliability.
    function recordJob(uint256 agentId, bool failed, uint256 newReliabilityBps) external onlyResolver {
        Agent storage a = agents[agentId];
        if (!a.exists) revert NoAgent();
        a.jobsTotal += 1;
        if (failed) a.jobsFailed += 1;
        a.reliabilityBps = newReliabilityBps;
        emit JobRecorded(agentId, failed, newReliabilityBps);
    }

    /// ERC-8004 reputation: submit immutable feedback for an agent.
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        _requireAgent(agentId);
        if (valueDecimals > 18) revert InvalidValueDecimals();
        if (_isApprovedOrOwner(msg.sender, agentId)) revert NotOwner();

        uint64 feedbackIndex = _lastFeedbackIndex[agentId][msg.sender] + 1;
        _lastFeedbackIndex[agentId][msg.sender] = feedbackIndex;
        if (!_clientSeen[agentId][msg.sender]) {
            _clientSeen[agentId][msg.sender] = true;
            _clientsByAgent[agentId].push(msg.sender);
        }

        Feedback storage feedback = _feedbacks[agentId][msg.sender][feedbackIndex];
        feedback.value = value;
        feedback.valueDecimals = valueDecimals;
        feedback.tag1 = tag1;
        feedback.tag2 = tag2;
        feedback.isRevoked = false;

        _emitNewFeedback(agentId, msg.sender, feedbackIndex, endpoint, feedbackURI, feedbackHash, feedback);
    }

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        _requireAgent(agentId);
        Feedback storage feedback = _feedbacks[agentId][msg.sender][feedbackIndex];
        if (feedbackIndex == 0 || _lastFeedbackIndex[agentId][msg.sender] < feedbackIndex) revert NoFeedback();
        if (feedback.isRevoked) revert NoFeedback();
        feedback.isRevoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    function appendResponse(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        string calldata responseURI,
        bytes32 responseHash
    ) external {
        _requireAgent(agentId);
        if (feedbackIndex == 0 || _lastFeedbackIndex[agentId][clientAddress] < feedbackIndex) revert NoFeedback();
        _responseTotals[agentId][clientAddress][feedbackIndex] += 1;
        _responseByResponder[agentId][clientAddress][feedbackIndex][msg.sender] += 1;
        emit ResponseAppended(agentId, clientAddress, feedbackIndex, msg.sender, responseURI, responseHash);
    }

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked)
    {
        _requireAgent(agentId);
        Feedback storage feedback = _feedbacks[agentId][clientAddress][feedbackIndex];
        return (feedback.value, feedback.valueDecimals, feedback.tag1, feedback.tag2, feedback.isRevoked);
    }

    function getClients(uint256 agentId) external view returns (address[] memory) {
        _requireAgent(agentId);
        return _clientsByAgent[agentId];
    }

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64) {
        _requireAgent(agentId);
        return _lastFeedbackIndex[agentId][clientAddress];
    }

    function getResponseCount(uint256 agentId, address clientAddress, uint64 feedbackIndex, address[] calldata responders)
        external
        view
        returns (uint64 count)
    {
        _requireAgent(agentId);
        if (feedbackIndex == 0 || _lastFeedbackIndex[agentId][clientAddress] < feedbackIndex) revert NoFeedback();
        if (responders.length == 0) {
            return _responseTotals[agentId][clientAddress][feedbackIndex];
        }
        for (uint256 i = 0; i < responders.length; ++i) {
            count += _responseByResponder[agentId][clientAddress][feedbackIndex][responders[i]];
        }
    }

    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
    {
        _requireAgent(agentId);
        if (clientAddresses.length == 0) revert NoClient();

        int256 totalScaled;
        for (uint256 i = 0; i < clientAddresses.length; ++i) {
            uint64 last = _lastFeedbackIndex[agentId][clientAddresses[i]];
            for (uint64 index = 1; index <= last; ++index) {
                Feedback storage feedback = _feedbacks[agentId][clientAddresses[i]][index];
                if (feedback.isRevoked) continue;
                if (!_matchesTag(feedback.tag1, tag1)) continue;
                if (!_matchesTag(feedback.tag2, tag2)) continue;
                count += 1;
                totalScaled += _scaleTo18(feedback.value, feedback.valueDecimals);
            }
        }

        if (count > 0) {
            summaryValueDecimals = 18;
            summaryValue = int128(totalScaled / int256(uint256(count)));
        }
    }

    function readAllFeedback(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2,
        bool includeRevoked
    )
        external
        view
        returns (
            address[] memory clients,
            uint64[] memory feedbackIndexes,
            int128[] memory values,
            uint8[] memory valueDecimals,
            string[] memory tag1s,
            string[] memory tag2s,
            bool[] memory revokedStatuses
        )
    {
        _requireAgent(agentId);
        uint256 matches;
        for (uint256 i = 0; i < clientAddresses.length; ++i) {
            uint64 last = _lastFeedbackIndex[agentId][clientAddresses[i]];
            for (uint64 index = 1; index <= last; ++index) {
                Feedback storage feedback = _feedbacks[agentId][clientAddresses[i]][index];
                if (!includeRevoked && feedback.isRevoked) continue;
                if (!_matchesTag(feedback.tag1, tag1)) continue;
                if (!_matchesTag(feedback.tag2, tag2)) continue;
                matches += 1;
            }
        }

        clients = new address[](matches);
        feedbackIndexes = new uint64[](matches);
        values = new int128[](matches);
        valueDecimals = new uint8[](matches);
        tag1s = new string[](matches);
        tag2s = new string[](matches);
        revokedStatuses = new bool[](matches);

        uint256 cursor;
        for (uint256 i = 0; i < clientAddresses.length; ++i) {
            uint64 last = _lastFeedbackIndex[agentId][clientAddresses[i]];
            for (uint64 index = 1; index <= last; ++index) {
                Feedback storage feedback = _feedbacks[agentId][clientAddresses[i]][index];
                if (!includeRevoked && feedback.isRevoked) continue;
                if (!_matchesTag(feedback.tag1, tag1)) continue;
                if (!_matchesTag(feedback.tag2, tag2)) continue;

                clients[cursor] = clientAddresses[i];
                feedbackIndexes[cursor] = index;
                values[cursor] = feedback.value;
                valueDecimals[cursor] = feedback.valueDecimals;
                tag1s[cursor] = feedback.tag1;
                tag2s[cursor] = feedback.tag2;
                revokedStatuses[cursor] = feedback.isRevoked;
                cursor += 1;
            }
        }
    }

    // ---- ERC-721 / ERC-165 accessors ----

    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert InvalidAddress();
        return _balances[owner];
    }

    function ownerOf(uint256 agentId) public view returns (address) {
        return _ownerOf(agentId);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == _ERC165_INTERFACE_ID || interfaceId == _ERC721_INTERFACE_ID || interfaceId == _ERC721_METADATA_INTERFACE_ID;
    }

    // ---- legacy read accessors ----

    function getAgent(uint256 agentId) external view returns (Agent memory) {
        return agents[agentId];
    }

    function isAuditor(uint256 agentId) external view returns (bool) {
        return agents[agentId].isAuditor;
    }

    function taskClassOf(uint256 agentId) external view returns (string memory) {
        return agents[agentId].taskClass;
    }

    function bondOf(uint256 agentId) external view returns (uint256) {
        return agents[agentId].bond;
    }

    // ---- internal identity helpers ----

    function _mintIdentity(address owner, string memory agentURI) internal returns (uint256 agentId) {
        if (owner == address(0)) revert InvalidAddress();
        agentId = ++agentCount;
        if (_exists(agentId)) revert AlreadyExists();

        _owners[agentId] = owner;
        _balances[owner] += 1;
        _tokenURIs[agentId] = agentURI;
        _agentWallet[agentId] = owner;
        _setReservedMetadata(agentId, abi.encode(owner));

        emit Transfer(address(0), owner, agentId);
    }

    function _emitRegistration(uint256 agentId, string memory agentURI, address owner) internal {
        emit Registered(agentId, agentURI, owner);
    }

    function _setAgentDefaults(
        uint256 agentId,
        address owner,
        string memory agentName,
        string memory taskClass,
        bool auditorFlag,
        uint256 bond,
        uint256 reliabilityBps
    ) internal {
        agents[agentId] = Agent({
            owner: owner,
            name: agentName,
            taskClass: taskClass,
            isAuditor: auditorFlag,
            bond: bond,
            reliabilityBps: reliabilityBps,
            jobsTotal: 0,
            jobsFailed: 0,
            exists: true
        });
    }

    function _applyMetadata(uint256 agentId, MetadataEntry[] calldata metadata) internal {
        for (uint256 i = 0; i < metadata.length; ++i) {
            bytes32 keyHash = keccak256(bytes(metadata[i].metadataKey));
            if (keyHash == _AGENT_WALLET_KEY) revert MetadataKeyReserved();
            _metadata[agentId][keyHash] = metadata[i].metadataValue;
            emit MetadataSet(agentId, metadata[i].metadataKey, metadata[i].metadataKey, metadata[i].metadataValue);
        }
    }

    function _setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) internal {
        _metadata[agentId][keccak256(bytes(metadataKey))] = metadataValue;
        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    function _setReservedMetadata(uint256 agentId, bytes memory metadataValue) internal {
        _metadata[agentId][_AGENT_WALLET_KEY] = metadataValue;
        emit MetadataSet(agentId, "agentWallet", "agentWallet", metadataValue);
    }

    function _emitNewFeedback(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash,
        Feedback storage feedback
    ) internal {
        emit NewFeedback(
            agentId,
            clientAddress,
            feedbackIndex,
            feedback.value,
            feedback.valueDecimals,
            feedback.tag1,
            feedback.tag1,
            feedback.tag2,
            endpoint,
            feedbackURI,
            feedbackHash
        );
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        address owner = _ownerOf(tokenId);
        if (owner != from) revert NotOwner();
        if (!_isApprovedOrOwner(msg.sender, tokenId)) revert NotApproved();
        if (to == address(0)) revert InvalidAddress();

        delete _tokenApprovals[tokenId];
        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[tokenId] = to;

        Agent storage agent = agents[tokenId];
        if (agent.exists) {
            agent.owner = to;
        }

        _agentWallet[tokenId] = address(0);
        _setReservedMetadata(tokenId, bytes(""));
        emit Transfer(from, to, tokenId);
    }

    function _exists(uint256 tokenId) internal view returns (bool) {
        return _owners[tokenId] != address(0);
    }

    function _ownerOf(uint256 tokenId) internal view returns (address) {
        address owner = _owners[tokenId];
        if (owner == address(0)) revert NoAgent();
        return owner;
    }

    function _requireAgent(uint256 agentId) internal view {
        if (!_exists(agentId)) revert NoAgent();
    }

    function _isApprovedOrOwner(address spender, uint256 tokenId) internal view returns (bool) {
        address owner = _ownerOf(tokenId);
        return spender == owner || getApproved(tokenId) == spender || isApprovedForAll(owner, spender);
    }

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                _EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(name)),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _isValidSignatureNow(address signer, bytes32 digest, bytes calldata signature) internal view returns (bool) {
        if (signer.code.length == 0) {
            if (signature.length != 65) return false;
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := calldataload(signature.offset)
                s := calldataload(add(signature.offset, 32))
                v := byte(0, calldataload(add(signature.offset, 64)))
            }
            if (v < 27) {
                v += 27;
            }
            return ecrecover(digest, v, r, s) == signer;
        }

        (bool success, bytes memory result) = signer.staticcall(
            abi.encodeWithSelector(IERC1271.isValidSignature.selector, digest, signature)
        );
        return success && result.length >= 4 && bytes4(result) == _ERC1271_MAGICVALUE;
    }

    function _matchesTag(string memory candidate, string calldata filter) internal pure returns (bool) {
        if (bytes(filter).length == 0) return true;
        return keccak256(bytes(candidate)) == keccak256(bytes(filter));
    }

    function _scaleTo18(int128 value, uint8 valueDecimals) internal pure returns (int256) {
        if (valueDecimals == 18) return int256(value);
        uint256 factor = 10 ** uint256(18 - valueDecimals);
        return int256(value) * int256(factor);
    }
}
