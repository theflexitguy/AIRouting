export default function DashboardLoading() {
  return (
    <div className="flex flex-col h-full">
      <div className="h-16 border-b border-border bg-background/95 flex items-center px-6">
        <div className="h-5 w-32 bg-accent animate-pulse rounded" />
      </div>
      <div className="flex-1 p-6 space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1,2,3,4].map(i => (
            <div key={i} className="rounded-lg border border-border bg-card p-6">
              <div className="h-3 w-20 bg-accent animate-pulse rounded mb-3" />
              <div className="h-8 w-16 bg-accent animate-pulse rounded mb-2" />
              <div className="h-2 w-24 bg-accent animate-pulse rounded" />
            </div>
          ))}
        </div>
        <div className="grid lg:grid-cols-2 gap-4">
          {[1,2].map(i => (
            <div key={i} className="rounded-lg border border-border bg-card p-6 h-64">
              <div className="h-4 w-32 bg-accent animate-pulse rounded mb-2" />
              <div className="h-3 w-48 bg-accent animate-pulse rounded mb-4" />
              <div className="h-full bg-accent/30 animate-pulse rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
