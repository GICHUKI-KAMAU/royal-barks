import type { MembershipStatus } from "../../../../shared/contracts.js";

interface StatusProps {
  value: MembershipStatus | string;
}

export function Status({ value }: StatusProps) {
  return <span className={`status ${value.replaceAll(" ", "-")}`}>{value}</span>;
}
