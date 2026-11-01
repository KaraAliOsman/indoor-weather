import { decodePrint, printPath } from '../storm/print.ts';

/**
 * 2D landing shown in the Quest Browser before entering AR (and again after
 * leaving). Plain DOM, no framework. After a storm it shows today's page:
 * the dry handprint in riso blue with a pink misregistration, the week, and
 * when a new page comes (direccion/canon.md §9).
 */
export interface TodayPage {
  /** Long date, e.g. "Sunday, November 1". */
  dateLabel: string;
  /** storm/print.ts run-length bits, or undefined when today has no print yet. */
  print: string | undefined;
  /** Last 7 days, oldest first. */
  week: ReadonlyArray<{ label: string; print: boolean; today: boolean }>;
  /** Milliseconds until local midnight. */
  msToNextPage: number;
}

export interface Landing {
  onEnter(handler: () => void): void;
  setReady(arSupported: boolean): void;
  setInSession(inSession: boolean): void;
  showToday(page: TodayPage): void;
}

export function createLanding(doc: Document): Landing {
  const button = doc.getElementById('enter-ar') as HTMLButtonElement;
  const status = doc.getElementById('status') as HTMLElement;
  const root = doc.getElementById('landing') as HTMLElement;
  const today = doc.getElementById('today') as HTMLElement;

  return {
    onEnter(handler) {
      // No awaits before handler(): requestSession must run in the user gesture.
      button.addEventListener('click', () => {
        if (!button.disabled) handler();
      });
    },
    setReady(arSupported) {
      if (arSupported) {
        button.disabled = false;
        button.textContent = 'Enter AR';
        status.textContent = 'Sit at a table with some free space in front of you.';
      } else {
        button.disabled = true;
        button.textContent = 'AR not available';
        status.textContent = window.isSecureContext
          ? 'Open this page in the Meta Quest Browser on a Quest 3 or 3S.'
          : 'This page needs HTTPS. Open the https:// link in the Meta Quest Browser.';
      }
      root.dataset.ready = String(arSupported);
    },
    setInSession(inSession) {
      root.dataset.session = String(inSession);
      button.textContent = inSession ? 'In AR…' : 'Enter AR';
      button.disabled = inSession;
    },
    showToday(page) {
      const bits = page.print ? decodePrint(page.print) : null;
      today.hidden = bits === null;
      if (!bits) return;
      const d = printPath(bits);
      for (const p of today.querySelectorAll<SVGPathElement>('#today-print path')) p.setAttribute('d', d);
      (doc.getElementById('today-date') as HTMLElement).textContent = page.dateLabel;
      const week = doc.getElementById('week') as HTMLElement;
      week.replaceChildren(
        ...page.week.map((w) => {
          const li = doc.createElement('li');
          li.textContent = w.label;
          li.dataset.print = String(w.print);
          li.dataset.today = String(w.today);
          return li;
        }),
      );
      const h = Math.floor(page.msToNextPage / 3_600_000);
      const m = Math.floor((page.msToNextPage % 3_600_000) / 60_000);
      (doc.getElementById('next-page') as HTMLElement).textContent = `New page in ${h} h ${m} min`;
      button.textContent = 'Enter AR again';
    },
  };
}
