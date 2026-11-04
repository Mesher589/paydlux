// The spending-rules page's client half. Served by the desk at /rules.js.
//
// The page is a plain HTML form, so it works with JavaScript off. This file
// only adds the two things a form cannot do by itself: a Remove button that
// queues the row for deletion and submits, and a confirm before a rule that
// gates money is loosened.
//
// No inline handlers, so the page's CSP keeps script-src 'self'. Category names
// arrive from the server already reduced to [a-z0-9_-]; they are still read
// through dataset, never interpolated into markup, so nothing here can be
// turned into HTML by a name.
const form = document.getElementById("rules");
if (!form) throw new Error("rules page has no #rules form");

// Hidden fields the server reads as "delete these". Accumulating rather than
// replacing means a human can remove three rows before pressing Save.
const hidden = (name) => {
  let el = form.querySelector(`input[name="${name}"]`);
  if (!el) {
    el = document.createElement("input");
    el.type = "hidden";
    el.name = name;
    form.appendChild(el);
  }
  return el;
};

document.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-del]");
  if (!b) return;
  e.preventDefault();
  const field = b.dataset.map ? "delmap" : "delcat";
  const el = hidden(field);
  const val = b.dataset.del;
  const have = el.value ? el.value.split(",") : [];
  if (!have.includes(val)) have.push(val);
  el.value = have.join(",");
  // The row goes immediately: the human sees the rule stop protecting them
  // before they press Save, which is the point of the confirm.
  b.closest("tr")?.remove();
  form.requestSubmit();
});

// A wider ceiling is the one edit that can only hurt. The ledger still caps a
// single payment at the mandate amount, but the daily budget and the seller
// list are ours to count, so raising them is a real loosening. Ask once.
const limits = ["maxPerPayment", "dailyBudget"];
const start = Object.fromEntries(
  limits.map((n) => [n, form.querySelector(`[name="${n}"]`)?.value ?? ""]));

form.addEventListener("submit", (e) => {
  const raised = limits.filter((n) => {
    const now = Number(form.querySelector(`[name="${n}"]`)?.value);
    const was = Number(start[n]);
    return Number.isFinite(now) && Number.isFinite(was) && now > was;
  });
  if (!raised.length) return;
  const ok = confirm(
    `This raises ${raised.join(" and ")}. Higher limits mean the agent may ask you for ` +
    `more money, more often. Continue?`);
  if (!ok) e.preventDefault();
});
