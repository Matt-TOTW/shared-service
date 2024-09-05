import './style.css';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div>
    <h2>Shared Service using only Broadcast Channels</h2>
    <div class="card">
      <p>Enter the number of seconds to wait before the worker is done:</p>
      <input id="secondsInput" type="number" placeholder="Enter seconds" value="2" />
      <button id="goWorker" type="button">Do it</button>
    </div>
    <p class="result">
      Ready
    </p>
  </div>
`;

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

const button = document.querySelector<HTMLButtonElement>('#goWorker')!;
const secondsInput = document.querySelector<HTMLInputElement>('#secondsInput')!;
let intervalId: number | null = null;
let counter = 0;

button.addEventListener('click', () => {
  const seconds = parseInt(secondsInput.value, 10);
  worker.postMessage(seconds);
  counter = 0;
  if (intervalId) clearInterval(intervalId);

  intervalId = window.setInterval(() => {
    counter += 100;
    document.querySelector<HTMLParagraphElement>('.result')!.textContent = `Working... ${(
      counter / 1000
    ).toFixed(2)}s`;
  }, 100);
});

worker.onmessage = () => {
  if (intervalId) clearInterval(intervalId);
  document.querySelector<HTMLParagraphElement>('.result')!.textContent = 'Done!';
};
