import './attribution.css'

/**
 * Yahoo's attribution, as their developer terms require it.
 *
 * "Developer must provide clear attribution to Yahoo Fantasy wherever Yahoo
 * Fantasy Information is displayed", and for web applications it must sit in
 * the footer of each such page and link to an official Yahoo Fantasy page.
 *
 * Rendered only where Yahoo's data actually is, and the callers decide that.
 * It first went on every screen, on the theory that over-attributing costs a
 * line of grey text — but on a Sleeper league's page it credited Sleeper's
 * numbers to Yahoo, which is a false statement made under someone else's name
 * rather than a cautious one. The exact wording is Yahoo's own example.
 *
 * The installed PWA is covered by the same footer: it is the informational
 * line their mobile clause asks for, and it appears on the settings tab, which
 * spans the Yahoo leagues.
 */
export function Attribution() {
  return (
    <footer className="attrib">
      Fantasy data provided by{' '}
      <a
        href="https://football.fantasysports.yahoo.com/"
        target="_blank"
        rel="noreferrer noopener"
      >
        Yahoo Fantasy
      </a>
    </footer>
  )
}
