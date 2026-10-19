import { formatKes } from "../../utils/format.js";

interface ReferenceRowProps {
  label: string;
  value: number;
  strong?: boolean;
}

export function ReferenceRow({ label, value, strong = false }: ReferenceRowProps) {
  return (
    <div className={`ref-row ${strong ? "strong" : ""}`}>
      <span>{label}</span>
      <b>{formatKes(value)}</b>
    </div>
  );
}
