import { render } from 'svelte/server';
import App from './App.svelte';

export const renderDirectory = (model) => render(App, { props: { model } }).body;
