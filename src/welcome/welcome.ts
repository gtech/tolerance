import { saveStrictness } from '../shared/strictness-settings';
import { STRICTNESS_PRESETS } from '../shared/constants';
import { getResearchOptIn, setResearchOptIn } from '../shared/research-consent';
import { LINKEDIN_SITE, hasAccess, requestAccess, removeAccess } from '../shared/optional-sites';

// First-run page: one question, answered by clicking
function init(): void {
  const done = document.getElementById('done');
  const choices = document.querySelectorAll<HTMLButtonElement>('.choice');

  for (const choice of choices) {
    choice.addEventListener('click', async () => {
      const level = parseInt(choice.dataset.level ?? '3', 10);
      await saveStrictness(level);
      choices.forEach(c => c.classList.toggle('selected', c === choice));
      if (done) done.textContent = `Set to ${STRICTNESS_PRESETS[level - 1].label}. You can close this tab and start browsing.`;
    });
  }

  // LinkedIn is an optional site: ticking this is what grants the extension linkedin.com.
  // The request has to be made straight from the change handler, before any await.
  const linkedin = document.getElementById('linkedin-opt-in') as HTMLInputElement | null;
  if (linkedin) {
    hasAccess(LINKEDIN_SITE.origins).then(granted => { linkedin.checked = granted; });
    linkedin.addEventListener('change', () => {
      const change = linkedin.checked ? requestAccess(LINKEDIN_SITE.origins) : removeAccess(LINKEDIN_SITE.origins);
      change.then(async () => { linkedin.checked = await hasAccess(LINKEDIN_SITE.origins); });
    });
  }

  const research = document.getElementById('research-opt-in') as HTMLInputElement | null;
  if (research) {
    getResearchOptIn().then(on => { research.checked = on; });
    research.addEventListener('change', () => setResearchOptIn(research.checked));
  }
}

document.addEventListener('DOMContentLoaded', init);
