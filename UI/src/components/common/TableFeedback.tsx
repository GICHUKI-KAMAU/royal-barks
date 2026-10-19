interface EmptyProps {
  col: number;
  text: string;
}

export function Empty({ col, text }: EmptyProps) {
  return (
    <tr>
      <td colSpan={col} className="empty-state">
        {text}
      </td>
    </tr>
  );
}
