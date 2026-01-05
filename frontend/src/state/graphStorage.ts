import type { Scene } from '../shared/types';

export type SavedGraph = {
  id: string;
  name: string;
  timestamp: number;
  scene: Scene;
  thumbnail?: string; // base64 encoded SVG or image
  user_id?: string;
  folder_id?: string;
};

export type Folder = {
  id: string;
  name: string;
  created_at: number;
};

export type GraphMetadata = {
  id: string;
  name: string;
  timestamp: number;
  user_id: string;
};

// API 기본 URL
// 프로덕션에서는 상대 경로 사용 (같은 서버), 개발에서는 localhost
const API_BASE_URL = import.meta.env.VITE_API_URL ||
  '';

/**
 * 모든 저장된 그래프 메타데이터 가져오기
 */
export async function getAllGraphs(nickname?: string): Promise<GraphMetadata[]> {
  try {
    const qs = nickname ? `?nickname=${encodeURIComponent(nickname)}` : '';
    const response = await fetch(`${API_BASE_URL}/api/graphs/list${qs}`, {
      credentials: 'include' // 쿠키 포함
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch graphs: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to load graphs:', error);
    return [];
  }
}

/**
 * 그래프 저장하기
 */
export async function saveGraph(name: string, scene: Scene, thumbnail?: string, nickname?: string, folderId?: string): Promise<string> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/graphs/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include', // 쿠키 포함
      body: JSON.stringify({
        name,
        scene,
        thumbnail,
        nickname,
        folder_id: folderId
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to save graph: ${response.statusText}`);
    }

    const result = await response.json();
    return result.graph_id;
  } catch (error) {
    console.error('Failed to save graph:', error);
    throw error;
  }
}

/**
 * 그래프 불러오기
 */
export async function loadGraph(id: string): Promise<SavedGraph | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/graphs/load/${id}`, {
      credentials: 'include' // 쿠키 포함
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`Failed to load graph: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to load graph:', error);
    return null;
  }
}

/**
 * 그래프 삭제하기
 */
export async function deleteGraph(id: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/graphs/delete/${id}`, {
      method: 'DELETE',
      credentials: 'include' // 쿠키 포함
    });

    if (!response.ok) {
      if (response.status === 404) {
        return false;
      }
      throw new Error(`Failed to delete graph: ${response.statusText}`);
    }

    return true;
  } catch (error) {
    console.error('Failed to delete graph:', error);
    return false;
  }
}

/**
 * 최근 그래프 전체 정보 가져오기
 */
export async function getRecentGraphsWithData(): Promise<SavedGraph[]> {
  try {
    const nickname = localStorage.getItem('alphacanvas_nickname') || '';
    const qs = nickname ? `&nickname=${encodeURIComponent(nickname)}` : '';
    const response = await fetch(`${API_BASE_URL}/api/graphs/recent?limit=10${qs}`, {
      credentials: 'include' // 쿠키 포함
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch recent graphs: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to load recent graphs:', error);
    return [];
  }
}

/**
 * 현재 scene을 JSON 문자열로 내보내기
 */
export function exportSceneToJSON(scene: Scene): string {
  return JSON.stringify(scene, null, 2);
}

/**
 * JSON 문자열에서 scene 가져오기
 */
export function importSceneFromJSON(json: string): Scene | null {
  try {
    const scene = JSON.parse(json);
    // 기본적인 유효성 검사
    if (!scene || !scene.nodes || !scene.view) {
      throw new Error('Invalid scene format');
    }
    return scene;
  } catch (error) {
    console.error('Failed to import scene from JSON:', error);
    return null;
  }
}

/**
 * 모든 사용자 목록 가져오기
 */
export async function getAllUsers(): Promise<string[]> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/graphs/users`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch users: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to load users:', error);
    return [];
  }
}

/**
 * 사용자 추가
 */
export async function addUser(username: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/graphs/users/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ username })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to add user');
    }

    return true;
  } catch (error) {
    console.error('Failed to add user:', error);
    throw error;
  }
}

/**
 * 사용자 이름 수정
 */
export async function updateUser(oldUsername: string, newUsername: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/graphs/users/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({
        old_username: oldUsername,
        new_username: newUsername
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to update user');
    }

    return true;
  } catch (error) {
    console.error('Failed to update user:', error);
    throw error;
  }
}

/**
 * 사용자 삭제
 */
export async function deleteUser(username: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/graphs/users/${encodeURIComponent(username)}`, {
      method: 'DELETE',
      credentials: 'include'
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to delete user');
    }

    return true;
  } catch (error) {
    console.error('Failed to delete user:', error);
    return false;
  }
}

/**
 * 모든 폴더 목록 가져오기
 */
export async function getAllFolders(): Promise<Folder[]> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/graphs/folders`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch folders: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to load folders:', error);
    return [];
  }
}

/**
 * 폴더 추가
 */
export async function addFolder(name: string): Promise<Folder | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/graphs/folders/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ name })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to add folder');
    }

    const result = await response.json();
    return result.folder;
  } catch (error) {
    console.error('Failed to add folder:', error);
    throw error;
  }
}

/**
 * 폴더 이름 수정
 */
export async function updateFolder(folderId: string, newName: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/graphs/folders/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({
        folder_id: folderId,
        new_name: newName
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to update folder');
    }

    return true;
  } catch (error) {
    console.error('Failed to update folder:', error);
    throw error;
  }
}

/**
 * 폴더 삭제
 */
export async function deleteFolder(folderId: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/graphs/folders/${encodeURIComponent(folderId)}`, {
      method: 'DELETE',
      credentials: 'include'
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to delete folder');
    }

    return true;
  } catch (error) {
    console.error('Failed to delete folder:', error);
    return false;
  }
}

/**
 * 그래프를 폴더로 이동
 */
export async function moveGraphToFolder(graphId: string, folderId?: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/graphs/move`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({
        graph_id: graphId,
        folder_id: folderId
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to move graph');
    }

    return true;
  } catch (error) {
    console.error('Failed to move graph:', error);
    return false;
  }
}

