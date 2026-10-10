/** CSS bars from real numeric values. Never invents figures. */
export default function SimpleBars({
  items,
}: {
  items: { label: string; value: number }[]
}) {
  const usable = items.filter((item) => Number.isFinite(item.value))
  const max = Math.max(0, ...usable.map((item) => Math.abs(item.value)))

  if (!usable.length) {
    return <p className="text-sm text-slate-600">No figures are available for this chart.</p>
  }

  return (
    <ul className="space-y-3">
      {usable.map((item) => {
        const width = max === 0 ? 0 : (Math.abs(item.value) / max) * 100
        return (
          <li key={item.label}>
            <div className="mb-1 flex justify-between text-xs text-slate-600">
              <span>{item.label}</span>
              <span className="tabular-nums">{item.value.toLocaleString('en-TZ')}</span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-gradient-to-r from-navy to-brand motion-safe:transition-[width] motion-safe:duration-700"
                style={{ width: `${width}%` }}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
