const DECIMAL_MOUSE_REPORT = /\x1b\[<?\d+;(?:-?\d+|NaN);(?:-?\d+|NaN)[Mm]/g;
const X10_MOUSE_REPORT_WITHOUT_POSITION = /\x1b\[M[\s\S]\0\0/g;

export function dropMouseReportsWithoutPosition(data: string): string {
  return data
    .replace(DECIMAL_MOUSE_REPORT, (report) =>
      report.includes("NaN") ? "" : report,
    )
    .replace(X10_MOUSE_REPORT_WITHOUT_POSITION, "");
}
