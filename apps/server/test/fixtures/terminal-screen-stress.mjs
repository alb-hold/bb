const rows = 24;
const cols = 80;
const frame = Array.from({ length: rows }, (_, row) => {
  const label = `ROW${String(row).padStart(2, "0")}`;
  return `\u001b[${row + 1};1H${label}${".".repeat(cols - label.length)}`;
}).join("");
const updates = Array.from({ length: 20_000 }, (_, index) => {
  const row = (index % rows) + 1;
  const col = cols;
  return `\u001b[${row};${col}H${index % 10}`;
}).join("");
process.stdout.write(`\u001b[2J\u001b[H${frame}${updates}`);
