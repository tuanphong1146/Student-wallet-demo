// avalanche-bridge.js (V6 - Verifiable receipt seals, safer wallet/chain handling, no request-id race)
const CONTRACT_ADDRESS_V1 = "0x9e01c5f142FA26f310073495f3eBB58DBaEef51b";
const CONTRACT_ADDRESS_V2 = "0x249f611c1852d2460E7524faC495c8f3F96c2a4f"; // StudentGroupVaultV2 trên Avalanche Fuji Testnet
const CONTRACT_ADDRESS_V3 = "0xfcCc67Dd8642640F4b17981aF349b4C092252F21"; // StudentGroupVaultV3 trên Avalanche Fuji Testnet
const FUJI_CHAIN_ID = "0xa869"; // 43113 - Avalanche Fuji Testnet
const FUJI_RPC = "https://api.avax-test.network/ext/bc/C/rpc";

const ABI_V1 = [
  "function getBalance() view returns (uint256)",
  "function getRequestsCount() view returns (uint256)",
  "function requests(uint256) view returns (uint256 id, string description, uint256 amount, address payable recipient, string receiptHash, uint256 approvalCount, bool executed)",
  "function deposit() payable",
  "function createExpenseRequest(string _description, uint256 _amount, address payable _recipient, string _receiptHash)",
  "function approveRequest(uint256 _requestId)",
  "function verifyReceipt(uint256 _requestId, string _hashToCheck) view returns (bool)"
];

const ABI_V2 = [
  "function getGroupBalance(string _groupId) view returns (uint256)",
  "function getGroupRequestIds(string _groupId) view returns (uint256[])",
  "function getRequestsCount() view returns (uint256)",
  "function requests(uint256) view returns (uint256 id, string groupId, string description, uint256 amount, address payable recipient, string receiptHash, uint256 approvalCount, bool executed, address creator)",
  "function deposit(string _groupId) payable",
  "function createExpenseRequest(string _groupId, string _description, uint256 _amount, address payable _recipient, string _receiptHash) returns (uint256)",
  "function approveRequest(uint256 _requestId)",
  "function verifyReceipt(uint256 _requestId, string _hashToCheck) view returns (bool)",
  "function executeRequest(uint256 _requestId)",
  "function sealReceipt(string _groupId, string _receiptHash) returns (uint256)",
  "function getSealsCount() view returns (uint256)",
  "function seals(uint256) view returns (string groupId, string receiptHash, address sealedBy, uint256 sealedAt)",
  "function verifySeal(uint256 _sealId, string _hashToCheck) view returns (bool)",
  "function isContributor(string _groupId, address _who) view returns (bool)",
  "function getContribution(string _groupId, address _who) view returns (uint256)",
  "function getContributorCount(string _groupId) view returns (uint256)",
  "function requiredApprovals(uint256) view returns (uint256)",
  "event ReceiptSealed(uint256 indexed sealId, string groupId, string receiptHash, address indexed sealedBy)"
];

const ABI_V3 = [
  ...ABI_V2.filter(x => !x.startsWith("function createExpenseRequest(")),
  "function createExpenseRequest(string _groupId, bytes32 _expenseKey, string _description, uint256 _amount, address payable _recipient, string _receiptHash) returns (uint256)",
  "function registrationDigest(string groupId, address owner, address[] members) view returns (bytes32)",
  "function registerGroup(string groupId, address owner, address[] members, bytes signature)",
  "function groupOwner(bytes32) view returns (address)",
  "function isGroupMember(bytes32,address) view returns (bool)",
  "function setGroupMember(string groupId, address member, bool allowed)"
];

window.AvaxWallet = {
  provider: null,
  signer: null,
  contract: null,
  userAddress: null,
  isV3: Boolean(CONTRACT_ADDRESS_V3),
  isV2: Boolean(CONTRACT_ADDRESS_V2) || Boolean(CONTRACT_ADDRESS_V3),
  avaxRateVnd: Number(localStorage.getItem("sw_avax_vnd_rate")) || 650000,
  cachedBalances: {},
  cachedRequests: {},

  getCurrentGroupMeta() {
    if (typeof myGroups !== "undefined" && typeof activeGroupId !== "undefined" && activeGroupId) {
      const g = myGroups.find(x => x.id === activeGroupId);
      if (g) return { id: String(g.id), code: g.group_code || String(g.id), name: g.name || "Nhóm chi tiêu" };
    }
    return { id: "default-group", code: "DEFAULT", name: "Nhóm chi tiêu" };
  },

  getLedger() {
    try {
      return JSON.parse(localStorage.getItem("sw_avax_group_ledger") || "{}");
    } catch (e) {
      return {};
    }
  },
  saveLedger(data) {
    try {
      localStorage.setItem("sw_avax_group_ledger", JSON.stringify(data));
    } catch (e) {}
  },
  recordGroupLedger(groupId, deltaAvax, reqId = null) {
    const ledger = this.getLedger();
    if (!ledger[groupId]) ledger[groupId] = { balance: 0, reqIds: [] };
    ledger[groupId].balance = Math.max(0, Number((ledger[groupId].balance + deltaAvax).toFixed(6)));
    if (reqId !== null && !ledger[groupId].reqIds.includes(reqId)) {
      ledger[groupId].reqIds.push(reqId);
    }
    this.saveLedger(ledger);
  },

  // Kiểm tra trạng thái niêm phong đồng bộ đa thiết bị (từ Supabase `exp.avax_seal` hoặc localStorage)
  getSealInfoForExpense(expOrId) {
    const exp = typeof expOrId === "object" && expOrId !== null
      ? expOrId
      : (typeof grpEx !== "undefined" ? grpEx.find(x => x.id === expOrId) : null);

    if (exp && exp.avax_seal && exp.avax_seal.txHash) {
      return exp.avax_seal;
    }
    const id = exp ? exp.id : expOrId;
    try {
      const map = JSON.parse(localStorage.getItem("sw_sealed_receipts") || "{}");
      return map[id] || null;
    } catch (e) {
      return null;
    }
  },

  async markReceiptSealed(expenseId, info) {
    // 1. Lưu local cache
    try {
      const map = JSON.parse(localStorage.getItem("sw_sealed_receipts") || "{}");
      map[expenseId] = info;
      localStorage.setItem("sw_sealed_receipts", JSON.stringify(map));
    } catch (e) {}

    // 2. Đồng bộ lên object nhóm & Supabase để thành viên khác trên điện thoại/máy khác cũng thấy ngay
    if (typeof grpEx !== "undefined") {
      const exp = grpEx.find(x => x.id === expenseId);
      if (exp) {
        exp.avax_seal = info;
        if (typeof saveLocalGrpEx === "function" && typeof activeGroupId !== "undefined" && activeGroupId) {
          saveLocalGrpEx(activeGroupId, grpEx);
        }
        if (typeof sb !== "undefined" && sb && !String(expenseId).startsWith("gex_")) {
          try {
            // Ưu tiên cột `avax_seal` (jsonb, có trong schema_groups_secure.sql)
            const r = await sb.from("group_expenses").update({ avax_seal: info }).eq("id", expenseId);
            if (r.error) {
              // Cột chưa tồn tại: lưu tạm vào `items` như phiên bản cũ
              const itemsWithMeta = Array.isArray(exp.items) ? [...exp.items] : [];
              const metaIdx = itemsWithMeta.findIndex(x => x && x._avax_seal);
              if (metaIdx >= 0) itemsWithMeta[metaIdx] = { _avax_seal: info };
              else itemsWithMeta.push({ _avax_seal: info });
              const r2 = await sb.from("group_expenses").update({ items: itemsWithMeta }).eq("id", expenseId);
              if (r2.error) throw r2.error;
            }
          } catch (e) {
            console.warn("Sync seal to Supabase:", e);
          }
        }
      }
    }
  },

  // JSON ổn định: sắp xếp khóa, bỏ giá trị undefined => cùng dữ liệu luôn cho cùng hash
  stable(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(x => (x === undefined ? "null" : this.stable(x))).join(",") + "]";
    return "{" + Object.keys(v).sort().filter(k => v[k] !== undefined)
      .map(k => JSON.stringify(k) + ":" + this.stable(v[k])).join(",") + "}";
  },

  async hashStr(raw) {
    const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  },

  async hashReceipt(receiptObj) {
    return this.hashStr(this.stable(receiptObj));
  },

  activeAddress() {
    return this.isV3 ? CONTRACT_ADDRESS_V3 : (this.isV2 ? CONTRACT_ADDRESS_V2 : CONTRACT_ADDRESS_V1);
  },

  // V2: chỉ ghi hash hóa đơn lên chain, không tạo yêu cầu rút tiền
  async sealGroupReceipt({ receiptRawData }) {
    if (!this.isV2) throw new Error("Cần contract V2 để niêm phong mà không tạo yêu cầu rút quỹ");
    if (!this.contract) await this.connect();
    const grp = this.getCurrentGroupMeta();
    const receiptHash = await this.hashReceipt(receiptRawData);
    const tx = await this.contract.sealReceipt(grp.id, receiptHash);
    const receipt = await tx.wait();

    let sealId = null;
    for (const log of receipt.logs) {
      try {
        const parsed = this.contract.interface.parseLog(log);
        if (parsed && parsed.name === "ReceiptSealed") { sealId = Number(parsed.args[0]); break; }
      } catch (e) {}
    }
    if (sealId === null) {
      const count = Number(await this.contract.getSealsCount());
      for (let i = count - 1; i >= 0 && i >= count - 30; i--) {
        const s = await this.contract.seals(i);
        if (s.receiptHash === receiptHash && s.groupId === grp.id) { sealId = i; break; }
      }
    }
    if (sealId === null) throw new Error("Đã gửi giao dịch nhưng chưa tìm thấy mã niêm phong. Hãy kiểm tra trên Snowtrace.");

    return {
      requestId: sealId,
      kind: "seal",
      receiptHash,
      payload: JSON.parse(JSON.stringify(receiptRawData)),
      contract: this.activeAddress(),
      txHash: receipt.hash,
      explorerUrl: `https://testnet.snowtrace.io/tx/${receipt.hash}`
    };
  },

  // Tìm id yêu cầu vừa tạo bằng receiptHash (không dựa vào "tổng số - 1" nên không bị lệch khi 2 người tạo cùng lúc)
  async findRequestId(receiptHash, maxScan = 30) {
    const count = Number(await this.contract.getRequestsCount());
    for (let i = count - 1; i >= 0 && i >= count - maxScan; i--) {
      const r = await this.contract.requests(i);
      if (r.receiptHash === receiptHash) return Number(r.id);
    }
    throw new Error("Giao dịch đã gửi nhưng chưa tìm thấy yêu cầu trên hợp đồng. Hãy làm mới và kiểm tra lại trên Snowtrace.");
  },

  // Kiểm tra niêm phong: (1) hash trên chain, (2) dữ liệu gốc đã lưu, (3) hóa đơn hiện tại có bị sửa sau đó không
  async verifySeal(seal, exp) {
    if (!seal || seal.requestId === undefined || seal.requestId === null || !seal.receiptHash) {
      throw new Error("Thiếu dữ liệu niêm phong");
    }
    const addr = seal.contract || CONTRACT_ADDRESS_V1;
    const useV3 = CONTRACT_ADDRESS_V3 && addr.toLowerCase() === CONTRACT_ADDRESS_V3.toLowerCase();
    const useV2 = useV3 || seal.kind === "seal" || (CONTRACT_ADDRESS_V2 && addr.toLowerCase() === CONTRACT_ADDRESS_V2.toLowerCase());
    const reader = new ethers.JsonRpcProvider(FUJI_RPC);
    const c = new ethers.Contract(addr, useV3 ? ABI_V3 : (useV2 ? ABI_V2 : ABI_V1), reader);
    const onchain = seal.kind === "seal"
      ? await c.verifySeal(Number(seal.requestId), seal.receiptHash)
      : await c.verifyReceipt(Number(seal.requestId), seal.receiptHash);
    let payloadOk = null;
    let matchesCurrent = null;
    if (seal.payload) {
      payloadOk = (await this.hashReceipt(seal.payload)) === seal.receiptHash;
      if (exp) {
        const cleanItems = (exp.items || []).filter(x => x && !x._avax_seal);
        const now = {
          shop: exp.s, date: exp.d, category: exp.c, totalVnd: exp.a, items: cleanItems
        };
        const then = {
          shop: seal.payload.shop, date: seal.payload.date, category: seal.payload.category,
          totalVnd: seal.payload.totalVnd, items: seal.payload.items || []
        };
        matchesCurrent = this.stable(now) === this.stable(then);
      }
    }
    return { onchain: !!onchain, payloadOk, matchesCurrent, hasPayload: !!seal.payload };
  },

  _bindWalletEvents() {
    if (this._bound || !window.ethereum || !window.ethereum.on) return;
    this._bound = true;
    const reset = (msg) => {
      this.provider = null; this.signer = null; this.contract = null; this.userAddress = null;
      this.cachedBalances = {}; this.cachedRequests = {};
      const btn = document.getElementById("btn-connect-avax");
      if (btn) btn.innerText = "🔗 Kết nối ví của bạn";
      if (typeof flash === "function") flash(msg);
    };
    window.ethereum.on("accountsChanged", () => {
      if (this._connecting) return;
      reset("Tài khoản ví đã thay đổi. Hãy bấm Kết nối ví để dùng lại.");
    });
    window.ethereum.on("chainChanged", () => {
      if (this._connecting) return;
      reset("Mạng ví đã thay đổi. Hãy kết nối lại ví (cần mạng Avalanche Fuji).");
    });
  },

  async _ensureFuji() {
    const cur = String(await window.ethereum.request({ method: "eth_chainId" })).toLowerCase();
    if (cur === FUJI_CHAIN_ID) return;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: FUJI_CHAIN_ID }] });
    } catch (err) {
      if (err && err.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: FUJI_CHAIN_ID,
            chainName: "Avalanche Fuji C-Chain",
            nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
            rpcUrls: ["https://api.avax-test.network/ext/bc/C/rpc"],
            blockExplorerUrls: ["https://testnet.snowtrace.io/"]
          }]
        });
      } else if (err && err.code === 4001) {
        throw new Error("Bạn đã từ chối chuyển sang mạng Avalanche Fuji.");
      } else {
        throw new Error("Không chuyển được sang mạng Avalanche Fuji: " + ((err && err.message) || err));
      }
    }
    const after = String(await window.ethereum.request({ method: "eth_chainId" })).toLowerCase();
    if (after !== FUJI_CHAIN_ID) throw new Error("Ví chưa ở mạng Avalanche Fuji (testnet). Hãy chuyển mạng rồi thử lại.");
  },

  async connect() {
    if (!window.ethereum) {
      alert("Bạn chưa cài ví điện tử (Core Wallet hoặc MetaMask) trên trình duyệt này!");
      throw new Error("Không tìm thấy ví trên trình duyệt");
    }

    this._connecting = true;
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (!accounts || !accounts.length) throw new Error("Ví chưa cấp quyền truy cập tài khoản");
      await this._ensureFuji();

      this.provider = new ethers.BrowserProvider(window.ethereum);
      this.signer = await this.provider.getSigner();
      this.userAddress = await this.signer.getAddress();
      const addr = this.isV3 ? CONTRACT_ADDRESS_V3 : (this.isV2 ? CONTRACT_ADDRESS_V2 : CONTRACT_ADDRESS_V1);
      const abi = this.isV3 ? ABI_V3 : (this.isV2 ? ABI_V2 : ABI_V1);
      this.contract = new ethers.Contract(addr, abi, this.signer);
    } catch (e) {
      this.provider = null; this.signer = null; this.contract = null; this.userAddress = null;
      throw e;
    } finally {
      this._connecting = false;
    }
    this._bindWalletEvents();
    return this.userAddress;
  },

  async getGroupBalance() {
    if (!this.contract) await this.connect();
    const grp = this.getCurrentGroupMeta();
    let val = 0;
    if (this.isV2) {
      const balWei = await this.contract.getGroupBalance(grp.id);
      val = Number(ethers.formatEther(balWei));
    } else {
      const totalWei = await this.contract.getBalance();
      const totalChain = Number(ethers.formatEther(totalWei));
      const ledger = this.getLedger();
      if (ledger[grp.id] && typeof ledger[grp.id].balance === "number") {
        val = Math.min(totalChain, ledger[grp.id].balance);
      } else {
        val = totalChain;
      }
    }
    this.cachedBalances[grp.id] = val;
    return val;
  },

  async depositToGroup(amountAvax) {
    if (!this.contract) await this.connect();
    const grp = this.getCurrentGroupMeta();
    const valWei = ethers.parseEther(amountAvax.toString());
    const tx = this.isV2
      ? await this.contract.deposit(grp.id, { value: valWei })
      : await this.contract.deposit({ value: valWei });
    const receipt = await tx.wait();
    this.recordGroupLedger(grp.id, Number(amountAvax));
    return {
      txHash: receipt.hash,
      explorerUrl: `https://testnet.snowtrace.io/tx/${receipt.hash}`
    };
  },

  async createGroupExpense({ description, amountAvax, recipientAddress, receiptRawData }) {
    if (!this.contract) await this.connect();
    const grp = this.getCurrentGroupMeta();
    const receiptHash = await this.hashReceipt(receiptRawData);
    const amountWei = ethers.parseEther(amountAvax.toString());

    let recipient = this.userAddress;
    if (recipientAddress && recipientAddress.trim()) {
      if (!ethers.isAddress(recipientAddress.trim())) {
        throw new Error("Địa chỉ ví người nhận không hợp lệ (phải bắt đầu bằng 0x...)");
      }
      recipient = recipientAddress.trim();
    }

    const expenseKey = ethers.keccak256(ethers.toUtf8Bytes(String(receiptRawData.expenseId || receiptHash)));
    const tx = this.isV3
      ? await this.contract.createExpenseRequest(grp.id, expenseKey, description, amountWei, recipient, receiptHash)
      : this.isV2
      ? await this.contract.createExpenseRequest(grp.id, description, amountWei, recipient, receiptHash)
      : await this.contract.createExpenseRequest(`[${grp.code}] ${description}`, amountWei, recipient, receiptHash);

    const receipt = await tx.wait();
    const reqId = await this.findRequestId(receiptHash);
    this.recordGroupLedger(grp.id, 0, reqId);

    return {
      requestId: reqId,
      receiptHash,
      payload: JSON.parse(JSON.stringify(receiptRawData)),
      contract: this.activeAddress(),
      txHash: receipt.hash,
      explorerUrl: `https://testnet.snowtrace.io/tx/${receipt.hash}`
    };
  },

  async approveExpense(requestId, amountAvax = 0) {
    if (!this.contract) await this.connect();
    const grp = this.getCurrentGroupMeta();
    const tx = await this.contract.approveRequest(requestId);
    const receipt = await tx.wait();
    const r = await this.contract.requests(requestId);
    if (r.executed && amountAvax > 0) {
      this.recordGroupLedger(grp.id, -Number(amountAvax));
    }
    return {
      executed: r.executed,
      txHash: receipt.hash,
      explorerUrl: `https://testnet.snowtrace.io/tx/${receipt.hash}`
    };
  },

  async getGroupRequests(limit = 15) {
    if (!this.contract) await this.connect();
    const grp = this.getCurrentGroupMeta();
    const list = [];

    if (this.isV2) {
      const ids = await this.contract.getGroupRequestIds(grp.id);
      for (let i = ids.length - 1; i >= Math.max(0, ids.length - limit); i--) {
        const r = await this.contract.requests(Number(ids[i]));
        list.push({
          id: Number(r.id),
          description: r.description,
          amountAvax: ethers.formatEther(r.amount),
          recipient: r.recipient,
          receiptHash: r.receiptHash,
          approvalCount: Number(r.approvalCount),
          executed: r.executed,
          requiredApprovals: Number(await this.contract.requiredApprovals(Number(ids[i])))
        });
      }
      this.cachedRequests[grp.id] = list;
      return list;
    }

    const count = Number(await this.contract.getRequestsCount());
    const ledger = this.getLedger()[grp.id] || { reqIds: [] };
    const prefix = `[${grp.code}] `;

    for (let i = count - 1; i >= 0 && list.length < limit; i--) {
      const r = await this.contract.requests(i);
      const rawDesc = r.description || "";
      const belongsToGroup = rawDesc.startsWith(prefix) || ledger.reqIds.includes(Number(r.id));
      if (belongsToGroup) {
        list.push({
          id: Number(r.id),
          description: rawDesc.startsWith(prefix) ? rawDesc.slice(prefix.length) : rawDesc,
          amountAvax: ethers.formatEther(r.amount),
          recipient: r.recipient,
          receiptHash: r.receiptHash,
          approvalCount: Number(r.approvalCount),
          executed: r.executed
        });
      }
    }
    this.cachedRequests[grp.id] = list;
    return list;
  }
};

// ===== CÁC HÀM QUY ĐỔI AVAX <-> VNĐ =====
window.formatVndApprox = function(avaxAmount) {
  const val = Number(avaxAmount) || 0;
  const vnd = Math.round(val * window.AvaxWallet.avaxRateVnd);
  return vnd.toLocaleString("vi-VN") + " đ";
};

window.updateAvaxRate = function(newRateStr) {
  const clean = Number(String(newRateStr).replace(/\D/g, ""));
  if (clean >= 1000) {
    window.AvaxWallet.avaxRateVnd = clean;
    localStorage.setItem("sw_avax_vnd_rate", String(clean));
    window.updateDepositVndPreview();
    window.updateExpVndPreview();
    window.syncAvaxTabUI();
    if (typeof flash === "function") flash("Đã cập nhật tỷ giá quy đổi: 1 AVAX = " + clean.toLocaleString("vi-VN") + " đ");
  }
};

window.updateDepositVndPreview = function() {
  const avax = Number(document.getElementById("avax-deposit-amount")?.value) || 0;
  const el = document.getElementById("avax-deposit-vnd");
  if (el) el.innerText = avax > 0 ? `≈ ${window.formatVndApprox(avax)}` : "≈ 0 đ";
};

window.updateExpVndPreview = function() {
  const avax = Number(document.getElementById("avax-exp-amount")?.value) || 0;
  const el = document.getElementById("avax-exp-vnd");
  if (el) el.innerText = avax > 0 ? `≈ ${window.formatVndApprox(avax)}` : "≈ 0 đ";
};

window.renderAvaxReqItemsHTML = function(reqs, grpName) {
  if (!reqs || !reqs.length) {
    return `<div class="mu" style="font-size:13.5px;padding:10px 0">Nhóm <b>${typeof esc === "function" ? esc(grpName) : grpName}</b> chưa có yêu cầu rút quỹ nào được tạo.</div>`;
  }
  return reqs.map(r => `
    <div style="padding:12px;border:1px solid var(--bd);border-radius:8px;margin-top:8px;background:var(--card);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <div>
        <div style="font-weight:600;font-size:14px">#${r.id} • ${typeof esc === "function" ? esc(r.description) : r.description} <span style="color:var(--bl)">(${r.amountAvax} AVAX ≈ ${window.formatVndApprox(r.amountAvax)})</span></div>
        <div class="mu" style="font-size:12px;margin-top:2px">Người nhận: <code>${r.recipient.slice(0, 6)}...${r.recipient.slice(-4)}</code> • Mã hóa đơn: <code>${r.receiptHash.slice(0, 14)}...</code> • Đã duyệt: <b>${r.approvalCount}/${r.requiredApprovals || '?'}</b></div>
      </div>
      <div>
        ${r.executed
          ? '<span class="tag" style="background:var(--gr)">✅ Đã chi tiền</span>'
          : (r.requiredApprovals && r.approvalCount >= r.requiredApprovals
              ? `<button class="btn" style="padding:6px 12px;font-size:13px" onclick="handleExecuteAvax(${r.id})">💸 Quỹ đã đủ · Chuyển tiền</button>`
              : `<button class="btn" style="padding:6px 12px;font-size:13px" onclick="handleApproveAvax(${r.id}, ${r.amountAvax})">👍 Đồng ý chi</button>`)}
      </div>
    </div>
  `).join('');
};

window.syncAvaxTabUI = async function() {
  if (!window.AvaxWallet || !window.AvaxWallet.userAddress) return;
  const addr = window.AvaxWallet.userAddress;
  const grp = window.AvaxWallet.getCurrentGroupMeta();
  const statusEl = document.getElementById("avax-wallet-status");
  const btnEl = document.getElementById("btn-connect-avax");
  const balEl = document.getElementById("avax-vault-balance");
  const balVndEl = document.getElementById("avax-vault-balance-vnd");

  if (statusEl) statusEl.innerHTML = `Ví của bạn: <b>${addr.slice(0, 6)}...${addr.slice(-4)}</b> • Két sắt riêng của nhóm <b>${typeof esc === "function" ? esc(grp.name) : grp.name}</b>`;
  if (btnEl) btnEl.innerText = "🟢 Đã kết nối ví";
  try {
    const bal = await window.AvaxWallet.getGroupBalance();
    if (balEl) balEl.innerText = bal + " AVAX";
    if (balVndEl) balVndEl.innerText = `Quy đổi tham khảo: ≈ ${window.formatVndApprox(bal)}`;
    await window.refreshAvaxRequests();
  } catch (e) {}
};

window.syncGroupMembersOnChain = async function() {
  const W = window.AvaxWallet;
  if (!W.isV3) return alert("Hãy deploy StudentGroupVaultV3.sol lên Fuji, sau đó điền CONTRACT_ADDRESS_V3 trước.");
  const grp = W.getCurrentGroupMeta();
  const group = typeof myGroups !== "undefined" ? myGroups.find(g => g.id === grp.id) : null;
  if (!group || group.owner_id !== uid) return alert("Chỉ trưởng nhóm mới có thể đăng ký/cập nhật thành viên trên blockchain.");
  const ownerMember = (group.members || []).find(m => m.user_id === group.owner_id);
  const ownerWallet = ownerMember && ownerMember.wallet;
  if (!ownerWallet || !ethers.isAddress(ownerWallet)) return alert("Trưởng nhóm cần lưu địa chỉ ví Avalanche trong hồ sơ trước.");
  let stage = "kết nối ví";
  try {
    if (!W.contract) await W.connect();
    if (W.userAddress.toLowerCase() !== ownerWallet.toLowerCase()) return alert("Hãy kết nối đúng ví Avalanche đã lưu trong hồ sơ của trưởng nhóm.");
    stage = "đọc trạng thái nhóm trên Fuji";
    const groupKey = ethers.keccak256(ethers.toUtf8Bytes(grp.id));
    const chainOwner = await W.contract.groupOwner(groupKey);
    const members = (group.members || []).map(m => {
      if (!m.wallet || !ethers.isAddress(m.wallet)) throw new Error(`${m.full_name} cần lưu ví Avalanche trước khi đăng ký nhóm.`);
      return ethers.getAddress(m.wallet);
    });

    if (chainOwner === ethers.ZeroAddress) {
      if (!members.some(a => a.toLowerCase() === ownerWallet.toLowerCase())) members.push(ethers.getAddress(ownerWallet));
      stage = "đọc mã xác nhận đăng ký từ Fuji";
      const digest = await W.contract.registrationDigest(grp.id, ownerWallet, members);
      stage = "xin ví ký xác nhận danh sách ví";
      let signature;
      try {
        // Call the injected wallet directly so its original error is preserved.
        signature = await window.ethereum.request({ method: "personal_sign", params: [digest, W.userAddress] });
      } catch (signError) {
        // A few injected wallets expect address before message. Never retry after user rejection.
        if (signError && signError.code === 4001) throw new Error("Bạn đã từ chối yêu cầu ký trong ví.");
        try {
          signature = await window.ethereum.request({ method: "personal_sign", params: [W.userAddress, digest] });
        } catch (retryError) {
          const explain = err => err?.data?.message || err?.info?.error?.message || err?.error?.message || err?.shortMessage || err?.message || String(err);
          throw new Error(`Ví không ký được thông điệp. Lần 1: ${explain(signError)}. Lần 2: ${explain(retryError)}`);
        }
      }
      stage = "gửi giao dịch đăng ký nhóm";
      await W.contract.registerGroup.staticCall(grp.id, ownerWallet, members, signature);
      const tx = await W.contract.registerGroup(grp.id, ownerWallet, members, signature);
      stage = "chờ Fuji xác nhận giao dịch";
      await tx.wait();
    } else {
      if (chainOwner.toLowerCase() !== ownerWallet.toLowerCase()) return alert("Mã nhóm đã được đăng ký bởi một ví khác. Hãy kiểm tra trước khi tiếp tục.");
      for (const member of members) {
        if (!(await W.contract.isGroupMember(groupKey, member))) {
          stage = "cập nhật ví thành viên trên Fuji";
          const tx = await W.contract.setGroupMember(grp.id, member, true);
          stage = "chờ Fuji xác nhận cập nhật thành viên";
          await tx.wait();
        }
      }
    }
    if (typeof flash === "function") flash("Đã đồng bộ danh sách ví thành viên lên Fuji.");
    await window.syncAvaxTabUI();
  } catch (e) {
    const detail = e.reason || e.data?.message || e.info?.error?.message || e.error?.message || e.shortMessage || e.message || String(e);
    alert(`Không đồng bộ được thành viên (bước: ${stage}): ${detail}`);
  }
};

window.handleConnectAvax = async function() {
  const statusEl = document.getElementById("avax-wallet-status");
  const btnEl = document.getElementById("btn-connect-avax");
  const balEl = document.getElementById("avax-vault-balance");
  const balVndEl = document.getElementById("avax-vault-balance-vnd");
  try {
    if (btnEl) btnEl.innerText = "Đang kết nối...";
    const addr = await window.AvaxWallet.connect();
    const grp = window.AvaxWallet.getCurrentGroupMeta();
    if (statusEl) statusEl.innerHTML = `Ví của bạn: <b>${addr.slice(0, 6)}...${addr.slice(-4)}</b> • Két sắt riêng của nhóm <b>${typeof esc === "function" ? esc(grp.name) : grp.name}</b>`;
    if (btnEl) btnEl.innerText = "🟢 Đã kết nối ví";
    const bal = await window.AvaxWallet.getGroupBalance();
    if (balEl) balEl.innerText = bal + " AVAX";
    if (balVndEl) balVndEl.innerText = `Quy đổi tham khảo: ≈ ${window.formatVndApprox(bal)}`;
    if (typeof flash === "function") flash("Đã kết nối ví quỹ chung thành công!");
    await window.refreshAvaxRequests();
  } catch (e) {
    if (btnEl) btnEl.innerText = "🔗 Kết nối ví của bạn";
    alert("Không thể kết nối ví: " + e.message);
  }
};

window.handleDepositAvax = async function() {
  const amount = document.getElementById("avax-deposit-amount")?.value;
  if (!amount || Number(amount) <= 0) return alert("Vui lòng nhập số tiền muốn góp vào quỹ!");
  const resBox = document.getElementById("avax-tx-result");
  if (resBox) resBox.innerHTML = "⏳ Đang chuyển tiền vào két sắt riêng của nhóm, vui lòng xác nhận trên ví...";
  try {
    const res = await window.AvaxWallet.depositToGroup(amount);
    const bal = await window.AvaxWallet.getGroupBalance();
    const balEl = document.getElementById("avax-vault-balance");
    const balVndEl = document.getElementById("avax-vault-balance-vnd");
    if (balEl) balEl.innerText = bal + " AVAX";
    if (balVndEl) balVndEl.innerText = `Quy đổi tham khảo: ≈ ${window.formatVndApprox(bal)}`;
    document.getElementById("avax-deposit-amount").value = "";
    window.updateDepositVndPreview();
    if (resBox) {
      resBox.innerHTML = `✅ Đã góp <b>${amount} AVAX</b> (≈ ${window.formatVndApprox(amount)}) vào quỹ nhóm! <a href="${res.explorerUrl}" target="_blank" style="color: var(--bl); font-weight: 600;">Xem biên lai công khai ↗</a>`;
    }
    if (typeof flash === "function") flash("Góp quỹ thành công!");
  } catch (e) {
    if (resBox) resBox.innerHTML = `<span class="err">❌ Giao dịch chưa hoàn tất: ${e.message}</span>`;
  }
};

window.handleCreateExpenseAvax = async function() {
  const desc = document.getElementById("avax-exp-desc")?.value?.trim();
  const amount = document.getElementById("avax-exp-amount")?.value;
  const recipientAddr = document.getElementById("avax-exp-recipient")?.value?.trim();
  if (!desc || !amount || Number(amount) <= 0) return alert("Vui lòng nhập đầy đủ nội dung khoản chi và số tiền!");
  const resBox = document.getElementById("avax-tx-result");
  if (resBox) resBox.innerHTML = "⏳ Đang niêm phong hóa đơn và gửi yêu cầu duyệt chi...";
  try {
    const grp = window.AvaxWallet.getCurrentGroupMeta();
    const rawReceipt = {
      groupId: grp.id,
      groupCode: grp.code,
      groupName: grp.name,
      description: desc,
      amountAvax: amount,
      amountVndApprox: Math.round(Number(amount) * window.AvaxWallet.avaxRateVnd),
      recipient: recipientAddr || window.AvaxWallet.userAddress,
      createdBy: window.AvaxWallet.userAddress,
      timestamp: Date.now()
    };

    const res = await window.AvaxWallet.createGroupExpense({
      description: desc,
      amountAvax: amount,
      recipientAddress: recipientAddr,
      receiptRawData: rawReceipt
    });

    document.getElementById("avax-exp-desc").value = "";
    document.getElementById("avax-exp-amount").value = "";
    if (document.getElementById("avax-exp-recipient")) document.getElementById("avax-exp-recipient").value = "";
    window.updateExpVndPreview();

    if (resBox) {
      resBox.innerHTML = `
        ✅ Đã tạo yêu cầu rút quỹ <b>#${res.requestId}</b> và niêm phong hóa đơn!<br/>
        <span class="mu" style="font-size: 12.5px;">Mã chống sửa đổi: <code>${res.receiptHash.slice(0, 20)}...</code></span> • 
        <a href="${res.explorerUrl}" target="_blank" style="color: var(--bl); font-weight: 600;">Xem biên lai công khai ↗</a>
      `;
    }
    if (typeof flash === "function") flash("Đã tạo yêu cầu chi tiêu và khóa hóa đơn!");
    await window.refreshAvaxRequests();
  } catch (e) {
    if (resBox) resBox.innerHTML = `<span class="err">❌ Không thể tạo yêu cầu: ${e.message}</span>`;
  }
};

window.handleApproveAvax = async function(reqId, amountAvax) {
  const resBox = document.getElementById("avax-tx-result");
  if (resBox) resBox.innerHTML = `⏳ Đang xác nhận đồng ý chi cho khoản #${reqId}...`;
  try {
    const res = await window.AvaxWallet.approveExpense(reqId, amountAvax);
    const bal = await window.AvaxWallet.getGroupBalance();
    const balEl = document.getElementById("avax-vault-balance");
    const balVndEl = document.getElementById("avax-vault-balance-vnd");
    if (balEl) balEl.innerText = bal + " AVAX";
    if (balVndEl) balVndEl.innerText = `Quy đổi tham khảo: ≈ ${window.formatVndApprox(bal)}`;
    if (resBox) {
      resBox.innerHTML = `✅ Bạn đã xác nhận đồng ý cho khoản #${reqId}! <a href="${res.explorerUrl}" target="_blank" style="color: var(--bl); font-weight: 600;">Xem biên lai công khai ↗</a>`;
    }
    await window.refreshAvaxRequests();
  } catch (e) {
    if (resBox) resBox.innerHTML = `<span class="err">❌ Lỗi xác nhận: ${e.message}</span>`;
  }
};

window.handleExecuteAvax = async function(reqId) {
  const resBox = document.getElementById("avax-tx-result");
  if (resBox) resBox.innerHTML = `⏳ Đang chuyển tiền cho yêu cầu #${reqId}...`;
  try {
    if (!window.AvaxWallet.contract) await window.AvaxWallet.connect();
    const tx = await window.AvaxWallet.contract.executeRequest(reqId);
    const receipt = await tx.wait();
    const bal = await window.AvaxWallet.getGroupBalance();
    const balEl = document.getElementById("avax-vault-balance");
    const balVndEl = document.getElementById("avax-vault-balance-vnd");
    if (balEl) balEl.innerText = bal + " AVAX";
    if (balVndEl) balVndEl.innerText = `Quy đổi tham khảo: ≈ ${window.formatVndApprox(bal)}`;
    if (resBox) resBox.innerHTML = `✅ Đã chuyển tiền cho yêu cầu #${reqId}. <a href="https://testnet.snowtrace.io/tx/${receipt.hash}" target="_blank" rel="noopener" style="color:var(--bl)">Xem giao dịch ↗</a>`;
    await window.refreshAvaxRequests();
  } catch (e) {
    if (resBox) resBox.innerHTML = `<span class="err">❌ Chưa thể chuyển tiền: ${e.reason || e.shortMessage || e.message}</span>`;
  }
};

window.refreshAvaxRequests = async function() {
  const listEl = document.getElementById("avax-req-list");
  if (!listEl || !window.AvaxWallet.contract) return;
  const grp = window.AvaxWallet.getCurrentGroupMeta();
  try {
    const reqs = await window.AvaxWallet.getGroupRequests(15);
    listEl.innerHTML = window.renderAvaxReqItemsHTML(reqs, grp.name);
    const byId = new Map(reqs.map(r => [Number(r.id), r]));
    if (typeof grpEx !== "undefined") {
      let changed = false;
      for (const exp of grpEx) {
        const rb = exp.avax_reimburse;
        const request = rb && byId.get(Number(rb.requestId));
        if (request && (rb.executed !== request.executed || rb.approvalCount !== request.approvalCount)) {
          exp.avax_reimburse = {...rb, executed: request.executed, approvalCount: request.approvalCount, requiredApprovals: request.requiredApprovals};
          changed = true;
        }
      }
      if (changed) {
        if (typeof saveLocalGrpEx === "function" && typeof activeGroupId !== "undefined") saveLocalGrpEx(activeGroupId, grpEx);
        if (typeof updGrpHist === "function") updGrpHist();
      }
    }
    const contribEl = document.getElementById("avax-contribution-list");
    if (contribEl && window.AvaxWallet.isV2 && typeof myGroups !== "undefined") {
      const group = myGroups.find(g => g.id === grp.id);
      const members = group ? group.members : [];
      const rows = await Promise.all(members.map(async m => {
        if (!m.wallet || !ethers.isAddress(m.wallet)) return {name:m.full_name, amount:0, hasWallet:false};
        const wei = await window.AvaxWallet.contract.getContribution(grp.id, m.wallet);
        return {name:m.full_name, amount:Number(ethers.formatEther(wei)), hasWallet:true};
      }));
      contribEl.innerHTML = rows.length ? rows.map(x => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--bd)"><span>${typeof esc === "function" ? esc(x.name) : x.name}${x.hasWallet ? "" : " <span class=mu>(chưa lưu ví)</span>"}</span><b>${x.amount} AVAX</b></div>`).join("") : '<div class="mu">Chưa có thành viên.</div>';
    }
  } catch (e) {
    console.warn("refreshAvaxRequests:", e);
  }
};

window.sealGroupExpenseOnChain = async function(expenseId) {
  if (typeof grpEx === "undefined") return;
  const exp = grpEx.find(x => x.id === expenseId);
  if (!exp) return alert("Không tìm thấy hóa đơn này!");

  const grp = window.AvaxWallet.getCurrentGroupMeta();
  const avaxRate = window.AvaxWallet.avaxRateVnd || 650000;
  const rawAvax = exp.a / avaxRate;
  const amountAvax = Math.max(0.001, Number(rawAvax.toFixed(4)));

  const sealOnly = window.AvaxWallet.isV2;
  const confirmMsg = sealOnly
    ? `Niêm phong hóa đơn "${exp.s}" (${Number(exp.a).toLocaleString("vi-VN")} đ) lên blockchain?\n\nChỉ ghi mã chống sửa đổi, KHÔNG rút tiền từ quỹ. Bạn cần là thành viên đã góp quỹ của nhóm ${grp.name}.`
    : `Niêm phong hóa đơn "${exp.s}" (${Number(exp.a).toLocaleString("vi-VN")} đ ≈ ${amountAvax} AVAX) lên Quỹ chung của nhóm ${grp.name}?\n\nLưu ý: thao tác này tạo một YÊU CẦU RÚT ${amountAvax} AVAX từ quỹ về ví của bạn. Tiền chỉ được chi khi đủ thành viên bấm "Đồng ý chi".`;
  if (!confirm(confirmMsg)) return;

  try {
    if (typeof flash === "function") flash("⏳ Đang kết nối ví và niêm phong hóa đơn...");
    if (!window.AvaxWallet.contract) await window.AvaxWallet.connect();

    const cleanItems = (exp.items || []).filter(x => x && !x._avax_seal);
    const receiptPayload = {
      expenseId: exp.id,
      groupId: grp.id,
      groupName: grp.name,
      shop: exp.s,
      date: exp.d,
      category: exp.c,
      totalVnd: exp.a,
      items: cleanItems,
      buyer: exp.memberName,
      sealedBy: window.AvaxWallet.userAddress,
      sealedAt: Date.now()
    };

    const desc = `${exp.s} (${Number(exp.a).toLocaleString("vi-VN")} đ - ${exp.d})`;
    const res = sealOnly
      ? await window.AvaxWallet.sealGroupReceipt({ receiptRawData: receiptPayload })
      : await window.AvaxWallet.createGroupExpense({
          description: desc,
          amountAvax: amountAvax,
          receiptRawData: receiptPayload
        });

    await window.AvaxWallet.markReceiptSealed(expenseId, {
      requestId: res.requestId,
      kind: sealOnly ? "seal" : "request",
      receiptHash: res.receiptHash,
      txHash: res.txHash,
      explorerUrl: res.explorerUrl,
      amountAvax: sealOnly ? undefined : amountAvax,
      payload: res.payload,
      contract: res.contract
    });

    if (typeof flash === "function") flash(`✅ Đã niêm phong hóa đơn #${res.requestId} lên Quỹ chung!`);
    if (typeof updGrpHist === "function") updGrpHist();
  } catch (e) {
    alert("Không thể niêm phong hóa đơn: " + (e.reason || e.shortMessage || e.message));
  }
};

window.verifyGroupSeal = async function(expenseId) {
  const exp = typeof grpEx !== "undefined" ? grpEx.find(x => x.id === expenseId) : null;
  const seal = window.AvaxWallet.getSealInfoForExpense(exp || expenseId);
  if (!seal) return alert("Hóa đơn này chưa được niêm phong.");
  try {
    if (typeof flash === "function") flash("⏳ Đang kiểm tra niêm phong trên blockchain...");
    const r = await window.AvaxWallet.verifySeal(seal, exp);
    const out = [];
    out.push(r.onchain ? "✅ Mã hóa đơn trên blockchain khớp với bản đã niêm phong." : "❌ Mã hóa đơn trên blockchain KHÔNG khớp.");
    if (!r.hasPayload) {
      out.push("ℹ️ Hóa đơn này được niêm phong bằng phiên bản cũ nên không lưu dữ liệu gốc, chưa đối chiếu được với hóa đơn hiện tại.");
    } else {
      out.push(r.payloadOk ? "✅ Dữ liệu gốc đã lưu đúng với mã trên blockchain." : "❌ Dữ liệu gốc đã lưu đã bị thay đổi.");
      if (r.matchesCurrent === true) out.push("✅ Hóa đơn hiện tại trùng với lúc niêm phong.");
      else if (r.matchesCurrent === false) out.push("⚠️ Hóa đơn hiện tại đã bị sửa sau khi niêm phong (cửa hàng, ngày, số tiền, danh mục hoặc món).");
    }
    alert(out.join("\n\n"));
  } catch (e) {
    alert("Không kiểm tra được: " + e.message);
  }
};

// ===== ĐỀ NGHỊ HOÀN TIỀN TỪ QUỸ CHO MỘT KHOẢN CHI (contract V2) =====
window.markReimburseRequested = async function(expenseId, info) {
  const exp = typeof grpEx !== "undefined" ? grpEx.find(x => x.id === expenseId) : null;
  if (!exp) return false;
  exp.avax_reimburse = info;
  if (typeof saveLocalGrpEx === "function" && typeof activeGroupId !== "undefined" && activeGroupId) {
    saveLocalGrpEx(activeGroupId, grpEx);
  }
  if (typeof sb !== "undefined" && sb && !String(expenseId).startsWith("gex_")) {
    const r = await sb.from("group_expenses").update({ avax_reimburse: info }).eq("id", expenseId);
    if (r.error) {
      console.warn("Lưu avax_reimburse:", r.error);
      if (typeof flash === "function") flash("Đã gửi yêu cầu lên blockchain nhưng chưa lưu được vào hệ thống (thiếu cột avax_reimburse, hãy chạy schema_groups_secure.sql).");
      return false;
    }
  }
  return true;
};

window.renderReimburseHTML = function(e, canEdit) {
  const W = window.AvaxWallet;
  if (!W || !W.isV2) return "";
  const q = typeof esc === "function" ? esc : (s => String(s));
  const rb = e.avax_reimburse;
  if (rb && rb.requestId !== undefined && rb.requestId !== null) {
    const rec = rb.recipient ? rb.recipient.slice(0, 6) + "..." + rb.recipient.slice(-4) : "";
    return `<div class="row" style="align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px">
      <span class="mu" style="font-size:13px">💸 Đề nghị hoàn từ quỹ #${Number(rb.requestId)}: ${q(rb.amountAvax)} AVAX → <code>${q(rec)}</code> · <a href="${q(rb.explorerUrl || "#")}" target="_blank" rel="noopener" style="color:var(--bl)">Giao dịch ↗</a></span>
      <span class="tag" style="background:${rb.executed ? "var(--gr)" : "var(--am)"}">${rb.executed ? "✅ Quỹ đã chi" : `⏳ Chờ duyệt${Number.isFinite(Number(rb.approvalCount)) && Number(rb.requiredApprovals) ? ` (${Number(rb.approvalCount)}/${Number(rb.requiredApprovals)})` : ""}`}</span>
    </div>`;
  }
  if (!canEdit) return "";
  return `<div class="row" style="align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px">
    <span class="mu" style="font-size:13px">Quỹ nhóm có thể hoàn tiền khoản này cho người đã mua.</span>
    <button class="btn o" style="padding:4px 10px;font-size:13px" onclick="requestReimburseOnChain('${e.id}')">💸 Đề nghị hoàn từ quỹ</button>
  </div>`;
};

window.requestReimburseOnChain = async function(expenseId) {
  const W = window.AvaxWallet;
  window._reimbursePending = window._reimbursePending || new Set();
  if (window._reimbursePending.has(String(expenseId))) return;
  if (!W.isV2) return alert("Cần contract V2 để dùng tính năng này.");
  if (typeof grpEx === "undefined") return;
  const exp = grpEx.find(x => x.id === expenseId);
  if (!exp) return alert("Không tìm thấy khoản chi này!");
  if (String(expenseId).startsWith("gex_")) return alert("Khoản chi này chưa đồng bộ lên máy chủ. Hãy tải lại trang rồi thử lại.");
  if (exp.avax_reimburse) return alert("Khoản chi này đã có đề nghị hoàn từ quỹ.");

  const grp = W.getCurrentGroupMeta();
  const members = (typeof myGroups !== "undefined" && typeof activeGroupId !== "undefined")
    ? ((myGroups.find(g => g.id === activeGroupId) || {}).members || []) : [];
  const buyer = members.find(m => m.user_id === exp.uid);
  const buyerName = (buyer && buyer.full_name) || exp.memberName || "người mua";
  const wallet = buyer && buyer.wallet;
  if (!wallet) {
    return alert(`${buyerName} chưa lưu địa chỉ ví. Nhờ ${buyerName} vào mục "Nhóm & Chia sẻ" để nhập ví Avalanche rồi thử lại.`);
  }

  const rate = W.avaxRateVnd || 650000;
  const amountAvax = Math.max(0.0001, Number((exp.a / rate).toFixed(6)));
  const short = wallet.slice(0, 6) + "..." + wallet.slice(-4);
  const msg = `Đề nghị hoàn ${amountAvax} AVAX (≈ ${Number(exp.a).toLocaleString("vi-VN")} đ) từ quỹ nhóm ${grp.name} về ví ${short} của ${buyerName}?\n\nTiền chỉ được chuyển khi đa số thành viên đã góp quỹ bấm "Đồng ý chi".`;
  if (!confirm(msg)) return;

  window._reimbursePending.add(String(expenseId));
  try {
    if (typeof flash === "function") flash("⏳ Đang kết nối ví và gửi đề nghị...");
    if (!W.contract) await W.connect();

    if (!(await W.contract.isContributor(grp.id, W.userAddress))) {
      return alert("Ví đang kết nối chưa góp tối thiểu 0.01 AVAX cho nhóm này nên chưa thể tạo đề nghị. Hãy góp quỹ ở mục Quỹ chung trước.");
    }
    const bal = await W.getGroupBalance();
    if (bal < amountAvax) {
      return alert(`Quỹ nhóm hiện có ${bal} AVAX, chưa đủ để hoàn ${amountAvax} AVAX. Hãy góp thêm quỹ rồi thử lại.`);
    }

    const cleanItems = (exp.items || []).filter(x => x && !x._avax_seal);
    const payload = {
      expenseId: exp.id,
      groupId: grp.id,
      groupName: grp.name,
      shop: exp.s,
      date: exp.d,
      category: exp.c,
      totalVnd: exp.a,
      items: cleanItems,
      buyer: exp.memberName,
      recipient: wallet,
      requestedBy: W.userAddress,
      requestedAt: Date.now()
    };
    const desc = `Hoàn tiền: ${exp.s} (${Number(exp.a).toLocaleString("vi-VN")} đ - ${exp.d})`;
    const res = await W.createGroupExpense({
      description: desc,
      amountAvax: amountAvax,
      recipientAddress: wallet,
      receiptRawData: payload
    });

    const saved = await window.markReimburseRequested(expenseId, {
      requestId: res.requestId,
      receiptHash: res.receiptHash,
      txHash: res.txHash,
      explorerUrl: res.explorerUrl,
      amountAvax: amountAvax,
      recipient: wallet,
      payload: res.payload,
      contract: res.contract,
      executed: false
    });

    if (!saved) {
      alert("Giao dịch đã lên blockchain nhưng trạng thái chưa lưu được lên máy chủ. Bản này đang được giữ tạm trên thiết bị; đừng gửi lại yêu cầu. Hãy chạy schema_groups_secure.sql rồi kiểm tra khoản chi.");
      if (typeof updGrpHist === "function") updGrpHist();
      return;
    }

    if (typeof flash === "function") flash(`✅ Đã tạo đề nghị hoàn #${res.requestId}. Các thành viên cần bấm "Đồng ý chi" ở mục Quỹ chung.`);
    if (typeof updGrpHist === "function") updGrpHist();
  } catch (e) {
    alert("Không thể tạo đề nghị hoàn: " + (e.reason || e.shortMessage || e.message));
  } finally {
    window._reimbursePending.delete(String(expenseId));
  }
};

