import { saveStrictness } from '../shared/strictness-settings';
import { STRICTNESS_PRESETS } from '../shared/constants';

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
}

document.addEventListener('DOMContentLoaded', init);
