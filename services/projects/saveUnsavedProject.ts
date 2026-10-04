import {
  isUnsavedProjectPath,
  useUnsavedProjectStore,
} from '../../store/useUnsavedProjectStore'

import { useEditorStore } from '../../store/useEditorStore'
import { createProject, saveFile } from '../../lib/tauriFs'

export interface SaveUnsavedProjectOptions {
  destination: string
}

export async function saveUnsavedProject({
  destination,
}: SaveUnsavedProjectOptions): Promise<string | null> {
  const project = useUnsavedProjectStore.getState()

  if (!project.projectName) {
    return null
  }

  const created = await createProject(
    destination,
    project.projectName
  )

  const projectRoot =
    typeof created === 'string'
      ? created
      : created.path

  const editor = useEditorStore.getState()

  for (const file of Object.values(project.files)) {
    const relativePath = file.path
      .replace(/^unsaved:\/\//, '')
      .replace(/\//g, '\\')

    const separator = projectRoot.endsWith('\\')
      ? ''
      : '\\'

    const realPath =
      `${projectRoot}${separator}${relativePath}`

    await saveFile({
      path: realPath,
      content: file.content,
    })

    const tab = editor.tabs.find(
      (candidate) => candidate.id === file.path
    )

    if (tab && isUnsavedProjectPath(tab.id)) {
      editor.renameTab(
        tab.id,
        realPath,
        file.name
      )
    }
  }

  project.clearProject()

  return projectRoot
}