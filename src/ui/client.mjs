import { hydrate } from 'svelte';
import App from './App.svelte';

const target = document.getElementById('directory');
const data = document.getElementById('page-data');
if (target && data) hydrate(App, { target, props: { model: JSON.parse(data.textContent) } });
