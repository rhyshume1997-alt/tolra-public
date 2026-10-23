# Drops COPY blocks that carry no rows from a pg_dump data file (used by scripts/restore-backup.sh).
# Each dropped table's name goes to stderr. Tracks COPY state: outside a block a "COPY ... FROM stdin;" line starts
# one (and is held back to see whether the very next line is the terminator); inside a block every line is data and
# is kept verbatim, whatever it looks like, until the terminator "\." on its own line ends that block.
{
  if (in_copy) {
    if (pending != "") {
      if ($0 == "\\.") { split(pending, w, " "); print w[2] > "/dev/stderr"; pending = ""; in_copy = 0; next }
      print pending; pending = ""
    }
    print
    if ($0 == "\\.") in_copy = 0
    next
  }
  if ($0 ~ /^COPY .* FROM stdin;$/) { pending = $0; in_copy = 1; next }
  print
}
END { if (pending != "") print pending }
