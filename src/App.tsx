import { useEffect, useState } from "react";
import {
  makeInvoice,
  registerInvoice,
  payInvoice,
  verifyInvoice,
  validateInvoice,
  deploySettlement,
  recoverSettlement,
  EXPLORER,
  type Invoice,
} from "./chain";
import "./style.css";
const DEPLOYMENT_KEY = "invoiceguard.deployment";
const SHARE_PREFIX = "#invoice=";
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
type TxHash = `0x${string}`;

function parsePortableInvoice(data: unknown): Invoice {
  if (typeof data !== "object" || data === null)
    throw Error("Invalid invoice package.");
  const packet = data as {
    version?: number;
    chainId?: number;
    invoice?: unknown;
  };
  if (packet.version !== 1 || packet.chainId !== 44005) {
    throw Error("Unsupported invoice network or format.");
  }
  const invoice = validateInvoice(packet.invoice);
  if (invoice.key.startsWith("sample-"))
    throw Error("The sample invoice IDs are reserved.");
  return invoice;
}

function portableInvoice(invoice: Invoice) {
  return { version: 1, chainId: 44005, invoice: validateInvoice(invoice) };
}

function deploymentHash(): TxHash | "" {
  const hash = localStorage.getItem(DEPLOYMENT_KEY) || "";
  return HASH_PATTERN.test(hash) ? (hash as TxHash) : "";
}

const sample: Invoice[] = [
  {
    key: "sample-204",
    reference: "INV-204",
    customer: "Northstar Studio",
    recipient: "0x0000000000000000000000000000000000000001",
    amount: "125.00",
    expiresAt: 0,
    nonce: "0x00",
    sample: true,
  },
  {
    key: "sample-203",
    reference: "INV-203",
    customer: "Studio June",
    recipient: "0x0000000000000000000000000000000000000002",
    amount: "48.00",
    expiresAt: 0,
    nonce: "0x00",
    sample: true,
    samplePaid: true,
  },
  {
    key: "sample-202",
    reference: "INV-202",
    customer: "Atlas Supply",
    recipient: "0x0000000000000000000000000000000000000003",
    amount: "210.00",
    expiresAt: 0,
    nonce: "0x00",
    sample: true,
  },
];
function saved(): Invoice[] {
  try {
    const v = JSON.parse(localStorage.getItem("invoiceguard.v1") || "null");
    return Array.isArray(v) && v.length && v.length <= 100
      ? v.map((x) =>
          x.sample
            ? (sample.find((s) => s.key === x.key) ?? validateInvoice(x))
            : validateInvoice(x),
        )
      : sample;
  } catch {
    return sample;
  }
}
export function App() {
  const [rows, setRows] = useState<Invoice[]>(saved),
    [selected, setSelected] = useState(rows[0].key),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [customer, setCustomer] = useState("all"),
    [modal, setModal] = useState(false),
    [ref, setRef] = useState(""),
    [name, setName] = useState(""),
    [recipient, setRecipient] = useState(""),
    [amount, setAmount] = useState(""),
    [guard, setGuard] = useState(
      localStorage.getItem("invoiceguard.contract") || "",
    ),
    [hash, setHash] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [checks, setChecks] = useState<{ label: string; pass: boolean }[]>([]),
    [proof, setProof] = useState<Awaited<
      ReturnType<typeof verifyInvoice>
    > | null>(null);
  const [deployment, setDeployment] = useState(deploymentHash),
    [share, setShare] = useState("");
  const invoice = rows.find((v) => v.key === selected) || rows[0];
  const status = (v: Invoice) =>
    v.paidHash
      ? "Paid"
      : v.samplePaid
        ? "Paid (sample)"
        : v.id
          ? "Awaiting payment"
          : v.sample
            ? "Awaiting payment"
            : "Draft";
  function save(v: Invoice[]) {
    localStorage.setItem("invoiceguard.v1", JSON.stringify(v));
    setRows(v);
  }
  function importInvoice(v: Invoice) {
    const existing = rows.find(
      (row) =>
        row.key === v.key ||
        (v.id && row.id === v.id && row.contract === v.contract),
    );
    if (
      existing?.id &&
      (existing.id !== v.id || existing.contract !== v.contract)
    ) {
      throw Error("This link conflicts with an existing registered invoice.");
    }
    if (!existing && rows.length >= 100)
      throw Error("Workspace limit reached.");
    if (!existing?.id)
      save(
        existing
          ? rows.map((row) => (row.key === v.key ? v : row))
          : [...rows, v],
      );
    setSelected(existing?.id ? existing.key : v.key);
    setChecks([]);
    setProof(null);
    setShare("");
    setHash("");
  }
  useEffect(() => {
    const fragment = window.location.hash;
    if (!fragment.startsWith(SHARE_PREFIX)) return;
    try {
      if (fragment.length > 12000) throw Error("Invoice link is too large.");
      const v = parsePortableInvoice(
        JSON.parse(decodeURIComponent(fragment.slice(SHARE_PREFIX.length))),
      );
      if (!v.id)
        throw Error("A shared payment link requires a registered invoice.");
      importInvoice(v);
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid invoice link.");
    }
  }, []);
  function update(v: Partial<Invoice>) {
    save(rows.map((r) => (r.key === invoice.key ? { ...r, ...v } : r)));
  }
  async function run(f: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await f();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function choose(key: string) {
    if (busy) return;
    setSelected(key);
    setChecks([]);
    setProof(null);
    setHash("");
    setShare("");
    setError("");
  }
  const filtered = rows.filter(
    (v) =>
      (v.reference + " " + v.customer)
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (customer === "all" || v.customer === customer) &&
      (filter === "all" ||
        (filter === "paid"
          ? !!(v.paidHash || v.samplePaid)
          : !(v.paidHash || v.samplePaid))),
  );
  async function verify() {
    setChecks([]);
    setProof(null);
    const p = await verifyInvoice(
      invoice,
      invoice.contract || guard,
      hash.trim(),
    );
    setChecks(p.checks);
    setProof(p);
    if (p.checks.every((c) => c.pass)) update({ paidHash: p.hash });
  }
  return (
    <>
      <header>
        <a className="brand" href="./">
          InvoiceGuard
        </a>
        <nav aria-label="Main">
          <button
            className="active"
            onClick={() =>
              document.getElementById("invoices")?.scrollIntoView()
            }
          >
            Invoices
          </button>
          <button onClick={() => document.getElementById("txhash")?.focus()}>
            Verify payment
          </button>
        </nav>
      </header>
      <main>
        <section className="heading">
          <div>
            <h1>Every invoice. One exact payment.</h1>
            <p>Create, collect and reconcile test stablecoin payments.</p>
          </div>
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              setModal(true);
              setError("");
            }}
          >
            ＋ Create invoice
          </button>
        </section>
        <div className="summary">
          <strong>
            {rows.every((v) => v.sample)
              ? "Sample workspace"
              : "Local workspace"}
          </strong>
          <span>
            {rows.length} invoices · {rows.filter((v) => v.paidHash).length}{" "}
            verified payments · {rows.filter((v) => v.samplePaid).length} sample
            paid · {rows.filter((v) => !(v.paidHash || v.samplePaid)).length}{" "}
            awaiting payment
          </span>
        </div>
        <div className="workspace">
          <section id="invoices" className="list">
            <div className="filters">
              <input
                aria-label="Search invoices"
                placeholder="Search invoices (e.g. INV-204, customer)"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select
                aria-label="Status filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">All statuses</option>
                <option value="paid">Paid</option>
                <option value="open">Unpaid</option>
              </select>
              <select
                aria-label="Customer filter"
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
              >
                <option value="all">All customers</option>
                {[...new Set(rows.map((v) => v.customer))].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Customer</th>
                    <th>Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((v) => (
                    <tr
                      key={v.key}
                      className={v.key === selected ? "selected" : ""}
                      onClick={() => choose(v.key)}
                    >
                      <td>
                        <button
                          className="row-link"
                          onClick={() => choose(v.key)}
                        >
                          {v.reference}
                        </button>
                      </td>
                      <td>{v.customer}</td>
                      <td className="amount">{v.amount} tUSD8</td>
                      <td>
                        <span
                          className={
                            v.paidHash || v.samplePaid ? "pill paid" : "pill"
                          }
                        >
                          {status(v)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filtered.length && (
                <p className="empty">No invoices match these filters.</p>
              )}
            </div>
            <div className="list-footer">
              Showing {filtered.length} of {rows.length} invoices
              <span>Stored in this browser</span>
            </div>
          </section>
          <aside>
            <h2>{invoice.reference}</h2>
            <dl>
              <div>
                <dt>Customer</dt>
                <dd>{invoice.customer}</dd>
              </div>
              <div>
                <dt>Recipient address</dt>
                <dd className="mono">{invoice.recipient}</dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd>
                  <strong>{invoice.amount} tUSD8</strong>
                </dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd>Aevum testnet</dd>
              </div>
            </dl>
            {!invoice.sample && (
              <button
                disabled={busy}
                className="row-link"
                onClick={() => {
                  const u = URL.createObjectURL(
                    new Blob(
                      [JSON.stringify(portableInvoice(invoice), null, 2)],
                      { type: "application/json" },
                    ),
                  );
                  const a = document.createElement("a");
                  a.href = u;
                  a.download = "invoiceguard-invoice.json";
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(u), 1000);
                }}
              >
                Export invoice for customer
              </button>
            )}
            <label>
              Import customer invoice
              <input
                disabled={busy}
                type="file"
                accept=".json,application/json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f)
                    run(async () => {
                      if (f.size > 12000)
                        throw Error("Invoice file too large.");
                      importInvoice(
                        parsePortableInvoice(JSON.parse(await f.text())),
                      );
                    });
                }}
              />
            </label>
            {invoice.id && (
              <button
                className="row-link"
                disabled={busy}
                onClick={() =>
                  setShare(
                    window.location.origin +
                      window.location.pathname +
                      SHARE_PREFIX +
                      encodeURIComponent(
                        JSON.stringify(portableInvoice(invoice)),
                      ),
                  )
                }
              >
                Create payment link
              </button>
            )}
            {share && (
              <label>
                Payment link
                <input
                  readOnly
                  value={share}
                  onFocus={(e) => e.target.select()}
                />
                <span>
                  Anyone with the link can read this invoice, including its
                  customer name and reference.
                </span>
              </label>
            )}
            <h3>Reconciliation</h3>
            <div className="notice">
              <strong>
                {invoice.sample
                  ? "Sample invoice — not on chain"
                  : invoice.paidHash
                    ? "Matching receipt verified"
                    : invoice.id
                      ? "Pending transaction"
                      : "Draft — register before payment"}
              </strong>
              <p>
                {invoice.sample
                  ? "Create your own invoice to register and verify a real testnet payment."
                  : invoice.id
                    ? "The settlement event and exact token transfer must both match."
                    : "Connect the recipient wallet to create the invoice on chain."}
              </p>
            </div>
            <label>
              Settlement contract
              <input
                disabled={busy || !!invoice.id}
                value={invoice.contract || guard}
                placeholder="Deployed InvoiceGuard address"
                onChange={(e) => {
                  setGuard(e.target.value);
                  localStorage.setItem("invoiceguard.contract", e.target.value);
                  setChecks([]);
                  setProof(null);
                }}
                spellCheck={false}
              />
            </label>
            {!invoice.id && (
              <details className="setup">
                <summary>Set up a settlement contract</summary>
                <p>
                  Deploy the reviewed InvoiceGuard contract on Aevum testnet.
                  Your wallet will ask you to approve the deployment and pay gas
                  in test tQDAY.
                </p>
                <a
                  href="https://faucet.qday.info/en"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open official faucet
                </a>
                <div className="setup-actions">
                  <button
                    className="outline"
                    disabled={busy || !!deployment}
                    onClick={() =>
                      run(async () => {
                        const result = await deploySettlement((tx) => {
                          setDeployment(tx);
                          localStorage.setItem(DEPLOYMENT_KEY, tx);
                        });
                        setGuard(result.address);
                        localStorage.setItem(
                          "invoiceguard.contract",
                          result.address,
                        );
                      })
                    }
                  >
                    Deploy on Aevum testnet
                  </button>
                  {deployment && (
                    <button
                      className="outline"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const result = await recoverSettlement(deployment);
                          setGuard(result.address);
                          localStorage.setItem(
                            "invoiceguard.contract",
                            result.address,
                          );
                        })
                      }
                    >
                      Load deployment address
                    </button>
                  )}
                </div>
                {deployment && (
                  <p>
                    Deployment recorded in this browser. Load the address again
                    if confirmation timed out.
                  </p>
                )}
                {deployment && (
                  <a
                    href={EXPLORER + "/tx/" + deployment}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Inspect deployment transaction
                  </a>
                )}
              </details>
            )}
            {!invoice.sample && !invoice.id && (
              <button
                className="outline"
                disabled={busy}
                onClick={() =>
                  run(async () => update(await registerInvoice(invoice, guard)))
                }
              >
                Register invoice in wallet
              </button>
            )}
            {invoice.id && !invoice.paidHash && (
              <button
                className="outline"
                disabled={busy}
                onClick={() =>
                  run(async () =>
                    setHash(
                      await payInvoice(invoice, invoice.contract || guard),
                    ),
                  )
                }
              >
                Pay with exact approval
              </button>
            )}
            <label htmlFor="txhash">
              Transaction hash
              <input
                disabled={busy}
                id="txhash"
                placeholder="Enter transaction hash (0x…)"
                value={hash}
                onChange={(e) => {
                  setHash(e.target.value);
                  setChecks([]);
                  setProof(null);
                }}
                spellCheck={false}
              />
            </label>
            <button
              className="primary full"
              disabled={busy}
              onClick={() => run(verify)}
            >
              {busy ? "Checking…" : "Verify on chain"}
            </button>
            <p className="fine">
              A successful payment must match network, contract, invoice, token,
              recipient and amount.
            </p>
            {checks.length > 0 && (
              <ul className="checks">
                {checks.map((c) => (
                  <li className={c.pass ? "pass" : "fail"} key={c.label}>
                    {c.pass ? "✓" : "×"} {c.label}
                  </li>
                ))}
              </ul>
            )}
            {proof && (
              <p>
                <a
                  href={EXPLORER + "/tx/" + proof.hash}
                  target="_blank"
                  rel="noreferrer"
                >
                  View transaction on Aevum explorer
                </a>
              </p>
            )}
            {proof && (
              <button
                className="row-link"
                onClick={() => {
                  const u = URL.createObjectURL(
                    new Blob([JSON.stringify({ invoice, proof }, null, 2)], {
                      type: "application/json",
                    }),
                  );
                  const a = document.createElement("a");
                  a.href = u;
                  a.download = "invoiceguard-reconciliation.json";
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(u), 1000);
                }}
              >
                Export reconciliation evidence
              </button>
            )}
            {error && !modal && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </aside>
        </div>
      </main>
      <footer>
        Testnet only ·{" "}
        {rows.some((v) => v.paidHash)
          ? "See recorded receipt evidence above"
          : "No live payment verified"}
      </footer>
      {modal && (
        <div className="backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-title"
            className="dialog"
          >
            <h2 id="create-title">Create invoice</h2>
            <p>
              Save a local draft, then register it from the recipient wallet.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setError("");
                try {
                  if (rows.length >= 100)
                    throw Error("Workspace limit reached.");
                  const v = makeInvoice(ref, name, recipient, amount);
                  save([...rows, v]);
                  choose(v.key);
                  setModal(false);
                  setRef("");
                  setName("");
                  setRecipient("");
                  setAmount("");
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              <label>
                Invoice reference
                <input
                  autoFocus
                  required
                  maxLength={64}
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                />
              </label>
              <label>
                Customer
                <input
                  required
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                Recipient address
                <input
                  required
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="0x…"
                />
              </label>
              <label>
                Amount (tUSD8)
                <input
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                />
              </label>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <div className="dialog-actions">
                <button
                  type="button"
                  className="outline"
                  onClick={() => {
                    setModal(false);
                    setError("");
                  }}
                >
                  Cancel
                </button>
                <button className="primary">Save draft</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
