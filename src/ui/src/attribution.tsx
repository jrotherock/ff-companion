import './attribution.css'

/**
 * Yahoo's attribution, as their developer terms require it.
 *
 * "Developer must provide clear attribution to Yahoo Fantasy wherever Yahoo
 * Fantasy Information is displayed", and for web applications it must sit in
 * the footer of each such page and link to an official Yahoo Fantasy page.
 *
 * Rendered on every screen of both apps rather than only the ones showing a
 * Yahoo league. Over-attributing costs a line of grey text; under-attributing
 * breaks the agreement, and "each page where it is displayed" is not a
 * judgement worth re-making every time a component moves. The exact wording is
 * Yahoo's own example, so there is nothing to argue about.
 *
 * The installed PWA is covered by the same footer: it is the informational
 * line their mobile clause asks for, and it appears on the settings tab along
 * with everywhere else.
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
