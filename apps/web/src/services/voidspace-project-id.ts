export const VOIDSPACE_PROJECT_PREFIX = "voidspace:";

export function buildVoidspaceProjectId(
  userId: string,
  sceneListId: string,
  avatarId?: string | null,
): string {
  const encodedUserId = encodeURIComponent(userId);
  const encodedAvatarId = encodeURIComponent(avatarId || "_");
  const encodedSceneListId = encodeURIComponent(sceneListId);
  return `${VOIDSPACE_PROJECT_PREFIX}v2:${encodedUserId}:${encodedAvatarId}:${encodedSceneListId}`;
}

export function buildLegacyVoidspaceProjectId(sceneListId: string): string {
  return `voidspace-${sceneListId}`;
}

export function buildUserScopedVoidspaceProjectId(
  userId: string,
  sceneListId: string,
): string {
  return `${VOIDSPACE_PROJECT_PREFIX}${userId}:${sceneListId}`;
}

export function parseVoidspaceProjectId(projectId: string): {
  sceneListId: string;
  userId?: string;
  avatarId?: string;
} | null {
  if (projectId.startsWith(VOIDSPACE_PROJECT_PREFIX)) {
    const payload = projectId.slice(VOIDSPACE_PROJECT_PREFIX.length);

    // v2 format: voidspace:v2:{userId}:{avatarId}:{sceneListId}
    if (payload.startsWith("v2:")) {
      const v2Parts = payload.split(":");
      if (v2Parts.length !== 4) return null;
      const userId = decodeURIComponent(v2Parts[1]);
      const avatarIdRaw = decodeURIComponent(v2Parts[2]);
      const sceneListId = decodeURIComponent(v2Parts[3]);
      if (!userId || !sceneListId) return null;
      return {
        userId,
        avatarId: avatarIdRaw === "_" ? undefined : avatarIdRaw,
        sceneListId,
      };
    }

    // v1 format: voidspace:{userId}:{sceneListId}
    const separatorIndex = payload.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex >= payload.length - 1) {
      return null;
    }
    const userId = payload.slice(0, separatorIndex);
    const sceneListId = payload.slice(separatorIndex + 1);
    if (!userId || !sceneListId) return null;
    return { userId, sceneListId };
  }

  if (projectId.startsWith("voidspace-")) {
    const sceneListId = projectId.slice("voidspace-".length);
    if (!sceneListId) return null;
    return { sceneListId };
  }

  return null;
}