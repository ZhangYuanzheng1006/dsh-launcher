/// <reference types="vite/client" />

import type { DshLauncherApi } from '../../shared/types'
import type { S6S7Api } from '../../shared/s6s7'

declare global {
  interface Window {
    dshLauncher: DshLauncherApi & S6S7Api
  }
}

export {}
