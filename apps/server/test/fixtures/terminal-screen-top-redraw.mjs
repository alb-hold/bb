const cols = 80;
const rows = 24;
const frames = Array.from({ length: 100 }, (_, frame) => {
  const lines = Array.from({ length: rows }, (_, row) => {
    const content = `top frame ${frame} row ${row}`.padEnd(cols);
    return `${content}\u001b[K${row < rows - 1 ? "\r\n" : ""}`;
  }).join("");
  return `\u001b[H${lines}`;
}).join("");

process.stdout.write(frames);
