import { BOOKING_URL, CTA_LABEL } from "@/lib/marketing";

/** The one call to action: "Book a free 20-minute chat", always the booking link, in a new tab. */
export function Cta({ className = "" }: { className?: string }) {
  return (
    <a
      href={BOOKING_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex min-h-12 items-center justify-center rounded-lg bg-[#1e8fff] px-6 py-3 text-base font-semibold text-[#05193a] shadow-lg shadow-black/20 transition hover:bg-[#5db0ff] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white ${className}`}
    >
      {CTA_LABEL}
    </a>
  );
}
