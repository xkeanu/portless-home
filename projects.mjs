// portless-home projects: Docker Compose stacks started with `portless compose up`.
// portless (>= 0.16) registers each published HTTP service through `portless
// alias`, so the route is static (pid 0) and named <service>.<project>.localhost
// (see docs/fixtures/routes.compose.json). routes.json carries no other marker.
// `portless run` uses the same dotted shape for worktree prefixes, but those
// routes have a live pid, so only static routes are grouped.
import { displayName } from './render.mjs';

export const composeService = (route) => {
	if (route.pid !== 0) return null;
	const match = /^(.+)\.([^.]+)\.localhost$/.exec(route.hostname);
	return match ? { project: match[2], service: match[1] } : null;
};

// Label and optional project for one route. Inside a project card the service
// name is enough; a rename in names.json still wins.
export const appFields = (route, names) => {
	const compose = composeService(route);
	if (!compose) return { label: displayName(route.hostname, names) };
	return { label: names[route.hostname] || compose.service, project: compose.project };
};

// Split apps into plain cards and project groups, keeping first-seen order.
export const groupProjects = (apps) => {
	const plain = [];
	const projects = new Map();
	for (const app of apps) {
		if (typeof app.project !== 'string') plain.push(app);
		else if (projects.has(app.project)) projects.get(app.project).push(app);
		else projects.set(app.project, [app]);
	}
	return { apps: plain, projects: [...projects].map(([name, services]) => ({ name, services })) };
};
