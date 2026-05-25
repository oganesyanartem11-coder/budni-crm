export default function InvoiceDetailLoading() {
  return (
    <div className="space-y-6">
      <div className="h-8 w-1/2 bg-bg rounded-lg animate-pulse" />
      <div className="h-4 w-1/3 bg-bg rounded animate-pulse" />
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="aspect-[3/4] bg-bg rounded-2xl animate-pulse" />
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 bg-bg rounded-2xl animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  )
}
