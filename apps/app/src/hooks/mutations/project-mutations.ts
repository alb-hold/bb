import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CreateProjectRequest,
  CreateProjectSourceRequest,
  ReorderProjectRequest,
  UpdateProjectRequest,
} from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import {
  applyProjectCreateResult,
  applyProjectDeleteResult,
  applyProjectUpdateResult,
} from "../cache-owners/project-cache-owner";
import {
  invalidateProjectListQueries,
  invalidateProjectSourceQueries,
  invalidateProjectUpdateQueries,
} from "../cache-owners/mutation-cache-effects";

interface AddLocalProjectSourceRequest {
  projectId: string;
  hostId: string;
  path: string;
}

interface UpdateLocalProjectSourceRequest {
  projectId: string;
  sourceId: string;
  path: string;
}

interface DeleteLocalProjectSourceRequest {
  projectId: string;
  sourceId: string;
}

interface UpdateProjectMutationRequest extends UpdateProjectRequest {
  id: string;
}

interface ReorderProjectMutationRequest extends ReorderProjectRequest {
  id: string;
}

export function useCreateProject() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to create project.",
    },
    mutationFn: (request: CreateProjectRequest) => sdk.projects.create(request),
    onSuccess: (project) => {
      applyProjectCreateResult({ project, queryClient });
      invalidateProjectListQueries({ queryClient });
    },
  });
}

export function useUpdateProject(options?: { showErrorToast?: boolean }) {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to update project.",
      showErrorToast: options?.showErrorToast ?? true,
    },
    mutationFn: ({ id, ...request }: UpdateProjectMutationRequest) =>
      sdk.projects.update({ projectId: id, ...request }),
    onSuccess: (project, variables) => {
      applyProjectUpdateResult({ project, queryClient });
      invalidateProjectUpdateQueries({ projectId: variables.id, queryClient });
    },
  });
}

export function useReorderProject() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to reorder project.",
    },
    mutationFn: ({ id, ...request }: ReorderProjectMutationRequest) =>
      sdk.projects.reorder({ projectId: id, ...request }),
    onSuccess: () => {
      invalidateProjectListQueries({ queryClient });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to remove project.",
    },
    mutationFn: async (projectId: string): Promise<void> => {
      await sdk.projects.delete({ projectId });
    },
    onSuccess: (_data, projectId) => {
      applyProjectDeleteResult({ projectId, queryClient });
    },
  });
}

export function useAddLocalProjectSource() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to add local source.",
    },
    mutationFn: ({ projectId, hostId, path }: AddLocalProjectSourceRequest) =>
      sdk.projects.sources.add({
        projectId,
        type: "local_path",
        hostId,
        path,
      }),
    onSuccess: (_data, variables) => {
      invalidateProjectSourceQueries({
        projectId: variables.projectId,
        queryClient,
      });
    },
  });
}

interface AddProjectSourceMutationRequest {
  projectId: string;
  request: CreateProjectSourceRequest;
}

export function useAddProjectSource() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      showErrorToast: false,
    },
    mutationFn: ({ projectId, request }: AddProjectSourceMutationRequest) =>
      sdk.projects.sources.add({ projectId, ...request }),
    onSuccess: (_data, variables) => {
      invalidateProjectSourceQueries({
        projectId: variables.projectId,
        queryClient,
      });
    },
  });
}

export function useUpdateLocalProjectSource() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to update local source.",
    },
    mutationFn: ({
      projectId,
      sourceId,
      path,
    }: UpdateLocalProjectSourceRequest) =>
      sdk.projects.sources.update({
        projectId,
        sourceId,
        type: "local_path",
        path,
      }),
    onSuccess: (_data, variables) => {
      invalidateProjectSourceQueries({
        projectId: variables.projectId,
        queryClient,
      });
    },
  });
}

export function useDeleteLocalProjectSource() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to remove source.",
    },
    mutationFn: async ({
      projectId,
      sourceId,
    }: DeleteLocalProjectSourceRequest): Promise<void> => {
      await sdk.projects.sources.delete({ projectId, sourceId });
    },
    onSuccess: (_data, variables) => {
      invalidateProjectSourceQueries({
        projectId: variables.projectId,
        queryClient,
      });
    },
  });
}

export { useUploadPromptAttachment } from "./prompt-attachment-mutation";
