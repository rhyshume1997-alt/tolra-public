// DO NOT MERGE: preview hub. A link in the real sidebar or a preview that has no preview screen lands here.
export default function NotFoundPage() {
  return (
    <main style={{ maxWidth: 480, margin: "15vh auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>No preview screen for this link</h1>
      <p style={{ color: "#566074", margin: "0 0 16px" }}>UI preview, sample data, nothing is saved. This part of the product has no preview yet.</p>
      <a href="/preview-hub" style={{ textDecoration: "underline" }}>Back to all previews</a>
    </main>
  );
}
