import { generateFileFromSandbox as generatePackageJsonFromSandbox } from '@codesandbox/common/lib/templates/configuration/package-json';
import {
  ModuleTab,
  NotificationButton,
  Sandbox,
  ServerContainerStatus,
  ServerStatus,
  TabType,
} from '@codesandbox/common/lib/types';
import { patronUrl } from '@codesandbox/common/lib/utils/url-generator';
import { NotificationStatus } from '@codesandbox/notifications';
import values from 'lodash-es/values';

import { ApiError } from './effects/api/apiFactory';
import { createOptimisticModule } from './utils/common';
import getItems from './utils/items';
import { defaultOpenedModule, mainModule } from './utils/main-module';
import { parseConfigurations } from './utils/parse-configurations';
import { Action, AsyncAction } from '.';

export const signIn: AsyncAction<{ useExtraScopes?: boolean }> = async (
  { state, effects, actions },
  options
) => {
  state.isAuthenticating = true;
  effects.analytics.track('Sign In', {});
  try {
    const jwt = await actions.internal.signInGithub(options);
    actions.internal.setJwt(jwt);
    state.user = await effects.api.getCurrentUser();
    actions.internal.setPatronPrice();
    actions.internal.setSignedInCookie();
    effects.analytics.identify('signed_in', true);
    effects.analytics.setUserId(state.user.id);
    actions.internal.setStoredSettings();
    effects.live.connect();
    actions.userNotifications.internal.initialize(); // Seemed a bit differnet originally?
    actions.refetchSandboxInfo();
  } catch (error) {
    actions.internal.addNotification({
      title: 'Github Authentication Error',
      type: 'error',
    });
  }
};

export const setStoredSettings: Action = ({ state, effects }) => {
  const settings = effects.settingsStore.getAll();

  if (settings.keybindings) {
    settings.keybindings = Object.keys(settings.keybindings).reduce(
      (value, key) =>
        value.concat({
          key,
          bindings: settings.keybindings[key],
        }),
      []
    );
  }

  Object.assign(state.preferences.settings, settings);
};

export const setPatronPrice: Action = ({ state }) => {
  state.patron.price = state.user.subscription
    ? Number(state.user.subscription.amount)
    : 10;
};

export const setSignedInCookie: Action = ({ state }) => {
  document.cookie = 'signedIn=true; Path=/;';
};

export const showUserSurveyIfNeeded: Action = ({ state, effects, actions }) => {
  if (state.user.sendSurvey) {
    // Let the server know that we've seen the survey
    effects.api.markSurveySeen();

    effects.notificationToast.add({
      title: 'Help improve CodeSandbox',
      message:
        "We'd love to hear your thoughts, it's 7 questions and will only take 2 minutes.",
      status: NotificationStatus.NOTICE,
      sticky: true,
      actions: {
        primary: [
          {
            label: 'Open Survey',
            run: () => {
              actions.modalOpened({
                modal: 'userSurvey',
              });
            },
          },
        ],
      },
    });
  }
};

export const addNotification: Action<{
  title: string;
  type: 'notice' | 'success' | 'warning' | 'error';
  timeAlive?: number;
  buttons?: Array<NotificationButton>;
}> = ({ state }, { title, type, timeAlive, buttons }) => {
  const now = Date.now();
  const timeAliveDefault = type === 'error' ? 6 : 3;

  state.notifications.push({
    id: now,
    title,
    type,
    buttons,
    endTime: now + (timeAlive || timeAliveDefault) * 1000,
  });
};

export const authorize: AsyncAction = async ({ state, effects }) => {
  try {
    state.authToken = await effects.api.getAuthToken();
  } catch (error) {
    state.editor.error = error.message;
  }
};

export const signInGithub: Action<
  { useExtraScopes?: boolean },
  Promise<string>
> = ({ effects }, options) => {
  const authPath =
    process.env.LOCAL_SERVER || process.env.STAGING
      ? '/auth/dev'
      : `/auth/github${options.useExtraScopes ? '?scope=user:email,repo' : ''}`;

  const popup = effects.browser.openPopup(authPath, 'sign in');

  return effects.browser
    .waitForMessage<{ jwt: string }>('signin')
    .then(data => {
      const { jwt } = data;

      popup.close();

      if (jwt) {
        return jwt;
      }

      throw new Error('Could not get sign in token');
    });
};

export const setJwt: Action<string> = ({ state, effects }, jwt) => {
  effects.jwt.set(jwt);
  state.jwt = jwt;
};

export const closeModals: Action<boolean> = ({ state, effects }, isKeyDown) => {
  if (
    state.currentModal === 'preferences' &&
    state.preferences.itemId === 'keybindings' &&
    isKeyDown
  ) {
    return;
  }

  state.currentModal = null;
  effects.keybindingManager.start();
};

export const setCurrentSandbox: AsyncAction<Sandbox> = async (
  { state, effects, actions },
  sandbox
) => {
  const oldSandboxId =
    state.editor.currentId === sandbox.id ? null : state.editor.currentId;

  state.editor.sandboxes[sandbox.id] = sandbox;
  state.editor.currentId = sandbox.id;

  let { currentModuleShortid } = state.editor;
  const parsedConfigs = parseConfigurations(sandbox);
  const main = mainModule(sandbox, parsedConfigs);

  state.editor.mainModuleShortid = main.shortid;

  // Only change the module shortid if it doesn't exist in the new sandbox
  // What is the scenario here?
  if (
    !sandbox.modules.find(module => module.shortid === currentModuleShortid)
  ) {
    const defaultModule = defaultOpenedModule(sandbox, parsedConfigs);

    currentModuleShortid = defaultModule.shortid;
  }

  const sandboxOptions = effects.router.getSandboxOptions();

  if (sandboxOptions.currentModule) {
    try {
      const resolvedModule = effects.utils.resolveModule(
        sandboxOptions.currentModule,
        sandbox.modules,
        sandbox.directories,
        // currentModule is a string... something wrong here?
        // @ts-ignore
        sandboxOptions.currentModule.directoryShortid
      );
      currentModuleShortid = resolvedModule
        ? resolvedModule.shortid
        : currentModuleShortid;
    } catch (err) {
      effects.notificationToast.warning(
        `Could not find the module ${sandboxOptions.currentModule}`
      );
    }
  }

  state.editor.currentModuleShortid = currentModuleShortid;
  state.editor.workspaceConfigCode = '';

  state.server.status = ServerStatus.INITIALIZING;
  state.server.containerStatus = ServerContainerStatus.INITIALIZING;
  state.server.error = null;
  state.server.hasUnrecoverableError = false;
  state.server.ports = [];

  const newTab: ModuleTab = {
    type: TabType.MODULE,
    moduleShortid: currentModuleShortid,
    dirty: true,
  };

  state.editor.tabs = [newTab];

  state.preferences.showPreview =
    sandboxOptions.isPreviewScreen || sandboxOptions.isSplitScreen;

  state.preferences.showEditor =
    sandboxOptions.isEditorScreen || sandboxOptions.isSplitScreen;

  if (sandboxOptions.initialPath)
    state.editor.initialPath = sandboxOptions.initialPath;
  if (sandboxOptions.fontSize)
    state.preferences.settings.fontSize = sandboxOptions.fontSize;
  if (sandboxOptions.highlightedLines)
    state.editor.highlightedLines = sandboxOptions.highlightedLines;
  if (sandboxOptions.hideNavigation)
    state.preferences.hideNavigation = sandboxOptions.hideNavigation;
  if (sandboxOptions.isInProjectView)
    state.editor.isInProjectView = sandboxOptions.isInProjectView;
  if (sandboxOptions.autoResize)
    state.preferences.settings.autoResize = sandboxOptions.autoResize;
  if (sandboxOptions.enableEslint)
    state.preferences.settings.enableEslint = sandboxOptions.enableEslint;
  if (sandboxOptions.forceRefresh)
    state.preferences.settings.forceRefresh = sandboxOptions.forceRefresh;
  if (sandboxOptions.expandDevTools)
    state.preferences.showDevtools = sandboxOptions.expandDevTools;
  if (sandboxOptions.runOnClick)
    state.preferences.runOnClick = sandboxOptions.runOnClick;

  state.workspace.project.title = sandbox.title || '';
  state.workspace.project.description = sandbox.description || '';
  state.workspace.project.alias = sandbox.alias || '';

  const items = getItems(state);
  const defaultItem = items.find(i => i.defaultOpen) || items[0];

  state.workspace.openedWorkspaceItem = defaultItem.id;

  await effects.executor.initializeExecutor(sandbox);

  [
    'connect',
    'disconnect',
    'sandbox:status',
    'sandbox:start',
    'sandbox:stop',
    'sandbox:error',
    'sandbox:log',
    'sandbox:hibernate',
    'sandbox:update',
    'sandbox:port',
    'shell:out',
    'shell:exit',
  ].forEach(message => {
    effects.executor.listen(message, actions.server.onSSEMessage);
  });

  effects.executor.setupExecutor();

  /*
    There seems to be a race condition here? Verify if this still happens with Overmind
  */
  if (oldSandboxId !== state.editor.currentId) {
    delete state.editor.sandboxes[oldSandboxId];
  }
};

export const updateCurrentSandbox: AsyncAction<Sandbox> = async (
  { state },
  sandbox
) => {
  state.editor.currentSandbox.team = sandbox.team || null;
  state.editor.currentSandbox.collection = sandbox.collection;
  state.editor.currentSandbox.owned = sandbox.owned;
  state.editor.currentSandbox.userLiked = sandbox.userLiked;
  state.editor.currentSandbox.title = sandbox.title;
};

export const ensurePackageJSON: AsyncAction = async ({ state, effects }) => {
  const sandbox = state.editor.currentSandbox;
  const existingPackageJson = sandbox.modules.find(
    module => module.directoryShortid == null && module.title === 'package.json'
  );

  if (sandbox.owned && !existingPackageJson) {
    const optimisticModule = createOptimisticModule({
      title: 'package.json',
      code: generatePackageJsonFromSandbox(sandbox),
    });

    state.editor.currentSandbox.modules.push(optimisticModule);

    try {
      const updatedModule = await effects.api.createModule(
        sandbox.id,
        optimisticModule
      );

      optimisticModule.id = updatedModule.id;
      optimisticModule.shortid = updatedModule.shortid;
    } catch (error) {
      sandbox.modules.splice(sandbox.modules.indexOf(optimisticModule), 1);
    }
  }
};

export const closeTabByIndex: Action<number> = ({ state }, tabIndex) => {
  const { currentModule } = state.editor;
  const tabs = state.editor.tabs as ModuleTab[];
  const isActiveTab = currentModule.shortid === tabs[tabIndex].moduleShortid;

  if (isActiveTab) {
    const newTab = tabIndex > 0 ? tabs[tabIndex - 1] : tabs[tabIndex + 1];

    if (newTab) {
      state.editor.currentModuleShortid = newTab.moduleShortid;
    }
  }

  state.editor.tabs.splice(tabIndex, 1);
};

export const onApiError: Action<ApiError> = (
  { state, actions, effects },
  error
) => {
  const { response } = error;

  if (response.status === 401) {
    // We need to implement a blocking modal to either sign in or refresh the browser to
    // continue in an anonymous state
  }

  if (!response || response.status >= 500) {
    effects.analytics.logError(error);
  }

  const result = response.data;

  if (result) {
    if ('errors' in result) {
      const errors = values(result.errors)[0];
      if (Array.isArray(errors)) {
        if (errors[0]) {
          error.message = errors[0]; // eslint-disable-line no-param-reassign,prefer-destructuring
        }
      } else {
        error.message = errors; // eslint-disable-line no-param-reassign
      }
    } else if (result.error) {
      error.message = result.error; // eslint-disable-line no-param-reassign
    } else if (response.status === 413) {
      error.message = 'File too large, upload limit is 5MB.';
    }
  }

  if (error.message.startsWith('You need to sign in to create more than')) {
    // Error for "You need to sign in to create more than 10 sandboxes"
    effects.analytics.track('Anonymous Sandbox Limit Reached', {
      errorMessage: error.message,
    });

    effects.notificationToast.add({
      message: error.message,
      status: NotificationStatus.ERROR,
      actions: {
        primary: [
          {
            label: 'Sign in',
            run: () => {
              actions.internal.signIn({});
            },
          },
        ],
      },
    });
  } else if (error.message.startsWith('You reached the maximum of')) {
    effects.analytics.track('Non-Patron Sandbox Limit Reached', {
      errorMessage: error.message,
    });

    effects.notificationToast.add({
      message: error.message,
      status: NotificationStatus.ERROR,
      actions: {
        primary: [
          {
            label: 'Open Patron Page',
            run: () => {
              window.open(patronUrl(), '_blank');
            },
          },
        ],
      },
    });
  } else if (
    error.message.startsWith(
      'You reached the limit of server sandboxes, you can create more server sandboxes as a patron.'
    )
  ) {
    effects.analytics.track('Non-Patron Server Sandbox Limit Reached', {
      errorMessage: error.message,
    });

    effects.notificationToast.add({
      message: error.message,
      status: NotificationStatus.ERROR,
      actions: {
        primary: [
          {
            label: 'Open Patron Page',
            run: () => {
              window.open(patronUrl(), '_blank');
            },
          },
        ],
      },
    });
  } else {
    if (
      error.message.startsWith(
        'You reached the limit of server sandboxes, we will increase the limit in the future. Please contact hello@codesandbox.io for more server sandboxes.'
      )
    ) {
      effects.analytics.track('Patron Server Sandbox Limit Reached', {
        errorMessage: error.message,
      });
    }

    effects.notificationToast.error(error.message);
  }
};
