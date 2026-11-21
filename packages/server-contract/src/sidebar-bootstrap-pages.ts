import type { ProjectWithThreadsResponse, SidebarBootstrapResponse } from "./api/projects.js";

function mergeProject(previous: ProjectWithThreadsResponse | undefined, project: ProjectWithThreadsResponse): ProjectWithThreadsResponse {
  if (!previous || previous.threads.length === 0) return project;
  if (project.threads.length === 0) return { ...project, threads: previous.threads };
  const rows = new Map(previous.threads.map((row) => [row.id, row]));
  for (const row of project.threads) rows.set(row.id, row);
  return { ...project, threads: [...rows.values()] };
}

export function mergeSidebarBootstrapPages(previous: SidebarBootstrapResponse | undefined, page: SidebarBootstrapResponse): SidebarBootstrapResponse {
  if (!previous) return page;
  const projects = new Map(previous.projects.map((project) => [project.id, project]));
  return {
    sections: page.sections,
    projects: page.projects.map((project) => mergeProject(projects.get(project.id), project)),
    personalProject: mergeProject(previous.personalProject, page.personalProject),
  };
}
