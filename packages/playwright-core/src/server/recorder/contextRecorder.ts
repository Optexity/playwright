/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { EventEmitter } from 'events';

import { RecorderCollection } from './recorderCollection';
import * as recorderSource from '../../generated/pollingRecorderSource';
import { eventsHelper, monotonicTime, quoteCSSAttributeValue } from '../../utils';
import { raceAgainstDeadline } from '../../utils/isomorphic/timeoutRunner';
import { BrowserContext } from '../browserContext';
import { languageSet } from '../codegen/languages';
import { Frame } from '../frames';
import { Page } from '../page';
import { ThrottledFile } from './throttledFile';
import { generateCode } from '../codegen/language';

import type { RegisteredListener } from '../../utils';
import type { Language, LanguageGenerator, LanguageGeneratorOptions } from '../codegen/types';
import type { Dialog } from '../dialog';
import type * as channels from '@protocol/channels';
import type * as actions from '@recorder/actions';
import type { Source } from '@recorder/recorderTypes';

type BindingSource = { frame: Frame, page: Page };

export interface ContextRecorderDelegate {
  rewriteActionInContext?(pageAliases: Map<Page, string>, actionInContext: actions.ActionInContext): Promise<void>;
}

export class ContextRecorder extends EventEmitter {
  static Events = {
    Change: 'change'
  };

  private _collection: RecorderCollection;
  private _pageAliases = new Map<Page, string>();
  private _lastPopupOrdinal = 0;
  private _lastDialogOrdinal = -1;
  private _lastDownloadOrdinal = -1;
  private _context: BrowserContext;
  private _params: channels.BrowserContextEnableRecorderParams;
  private _delegate: ContextRecorderDelegate;
  private _recorderSources: Source[];
  private _throttledOutputFile: ThrottledFile | null = null;
  private _orderedLanguages: LanguageGenerator[] = [];
  private _listeners: RegisteredListener[] = [];

  constructor(context: BrowserContext, params: channels.BrowserContextEnableRecorderParams, delegate: ContextRecorderDelegate) {
    super();
    this._context = context;
    this._params = params;
    this._delegate = delegate;
    this._recorderSources = [];
    const language = params.language || context.attribution.playwright.options.sdkLanguage;
    const contentDir = params.contentDir || 'playwright_recorder_output';
    this.setOutput(language, params.outputFile);

    // Make a copy of options to modify them later.
    const languageGeneratorOptions: LanguageGeneratorOptions = {
      browserName: context._browser.options.name,
      launchOptions: { headless: false, ...params.launchOptions, tracesDir: undefined },
      contextOptions: { ...params.contextOptions },
      deviceName: params.device,
      saveStorage: params.saveStorage,
      contentDir: contentDir,
    };

    this._collection = new RecorderCollection(this._pageAliases);
    this._collection.on('change', (actions: actions.ActionInContext[]) => {
      this._recorderSources = [];
      // console.log('Inside on Change in contextRecorder.ts: ' + actions.map(a => a.action.name).join(', '));
      for (const languageGenerator of this._orderedLanguages) {
        const { header, footer, actionTexts, text } = generateCode(actions, languageGenerator, languageGeneratorOptions);
        const source: Source = {
          isRecorded: true,
          label: languageGenerator.name,
          group: languageGenerator.groupName,
          id: languageGenerator.id,
          text,
          header,
          footer,
          actions: actionTexts,
          language: languageGenerator.highlighter,
          highlight: []
        };
        source.revealLine = text.split('\n').length - 1;
        this._recorderSources.push(source);
        if (languageGenerator === this._orderedLanguages[0])
          this._throttledOutputFile?.setContent(source.text);
      }
      this.emit(ContextRecorder.Events.Change, {
        sources: this._recorderSources,
        actions
      });
    });
    context.on(BrowserContext.Events.BeforeClose, () => {
      this._throttledOutputFile?.flush();
    });
    this._listeners.push(eventsHelper.addEventListener(process, 'exit', () => {
      this._throttledOutputFile?.flush();
    }));
    this.setEnabled(params.mode === 'recording');
  }

  setOutput(codegenId: string, outputFile?: string) {
    const languages = languageSet();
    const primaryLanguage = [...languages].find(l => l.id === codegenId);
    if (!primaryLanguage)
      throw new Error(`\n===============================\nUnsupported language: '${codegenId}'\n===============================\n`);
    languages.delete(primaryLanguage);
    this._orderedLanguages = [primaryLanguage, ...languages];
    this._throttledOutputFile = outputFile ? new ThrottledFile(outputFile) : null;
    this._collection?.restart();
  }

  languageName(id?: string): Language {
    for (const lang of this._orderedLanguages) {
      if (!id || lang.id === id)
        return lang.highlighter;
    }
    return 'javascript';
  }

  async install() {
    this._context.on(BrowserContext.Events.Page, (page: Page) => this._onPage(page));
    for (const page of this._context.pages())
      this._onPage(page);
    this._context.on(BrowserContext.Events.Dialog, (dialog: Dialog) => this._onDialog(dialog.page(), ''));

    // Input actions that potentially lead to navigation are intercepted on the page and are
    // performed by the Playwright.
    await this._context.exposeBinding('__pw_recorderPerformAction', false,
      (source: BindingSource, action: actions.PerformOnRecordAction) => this._performAction(source.frame, action));

    // Other non-essential actions are simply being recorded.
    await this._context.exposeBinding('__pw_recorderRecordAction', false,
      (source: BindingSource, action: actions.Action) => this._recordAction(source.frame, action));

    await this._context.extendInjectedScript(recorderSource.source);
  }

  setEnabled(enabled: boolean) {
    this._collection.setEnabled(enabled);
  }

  dispose() {
    eventsHelper.removeEventListeners(this._listeners);
  }

  private async _onPage(page: Page) {
    // First page is called page, others are called popup1, popup2, etc.
    const frame = page.mainFrame();
    await new Promise(resolve => setTimeout(resolve, 5000));
    const content = await frame.content();
    page.on('close', () => {
      const timestamp = new Date().getTime();
      const _uuid = timestamp.toString() + '_' + Math.random().toString(36).substring(2, 15);
      this._collection.addRecordedAction({
        frame: this._describeMainFrame(page),
        action: {
          name: 'closePage',
          signals: [],
        },
        startTime: monotonicTime(),
        uuid: _uuid,
        // content: content,
      });
      this._pageAliases.delete(page);
    });
    frame.on(Frame.Events.InternalNavigation, event => {
      if (event.isPublic)
        this._onFrameNavigated(frame, page, content);
    });
    page.on(Page.Events.Download, () => this._onDownload(page, content));
    const suffix = this._pageAliases.size ? String(++this._lastPopupOrdinal) : '';
    const pageAlias = 'page' + suffix;
    this._pageAliases.set(page, pageAlias);

    if (page.opener()) {
      this._onPopup(page.opener()!, page, content);
    } else {
      const timestamp = new Date().getTime();
      const _uuid = timestamp.toString() + '_' + Math.random().toString(36).substring(2, 15);
      // console.log('Inside _onPage in contextRecorder.ts: ' + frame.url());
      this._collection.addRecordedAction({
        frame: this._describeMainFrame(page),
        action: {
          name: 'openPage',
          url: frame.url(),
          signals: [],
        },
        startTime: monotonicTime(),
        uuid: _uuid,
        // content: content,
      });
    }
  }

  clearScript(): void {
    this._collection.restart();
    if (this._params.mode === 'recording') {
      for (const page of this._context.pages())
        this._onFrameNavigated(page.mainFrame(), page, '');
    }
  }

  runTask(task: string): void {
    // TODO: implement
  }

  private _describeMainFrame(page: Page): actions.FrameDescription {
    return {
      pageAlias: this._pageAliases.get(page)!,
      framePath: [],
    };
  }

  private async _describeFrame(frame: Frame): Promise<actions.FrameDescription> {
    return {
      pageAlias: this._pageAliases.get(frame._page)!,
      framePath: await generateFrameSelector(frame),
    };
  }

  testIdAttributeName(): string {
    return this._params.testIdAttributeName || this._context.selectors().testIdAttributeName() || 'data-testid';
  }

  private async _createActionInContext(frame: Frame, action: actions.Action): Promise<actions.ActionInContext> {
    const timestamp = new Date().getTime();
    const _uuid = timestamp.toString() + '_' + Math.random().toString(36).substring(2, 15);
    const frameDescription = await this._describeFrame(frame);
    const content = await frame.content();
    const actionInContext: actions.ActionInContext = {
      frame: frameDescription,
      action,
      description: undefined,
      startTime: monotonicTime(),
      uuid: _uuid,
      content: content,
    };
    await this._delegate.rewriteActionInContext?.(this._pageAliases, actionInContext);
    return actionInContext;
  }

  private async _performAction(frame: Frame, action: actions.PerformOnRecordAction) {
    // action.url = frame.url();
    // console.log('Inside _performAction in contextRecorder.ts: ' + action.name);
    // fs.writeFileSync('playwright_recorder_output/' + _uuid + ".html", await frame.content());
    // page.screenshot(randomUUID.jpeg)
    await this._collection.performAction(await this._createActionInContext(frame, action));
  }

  private async _recordAction(frame: Frame, action: actions.Action) {
    // action.url = frame.url();
    // console.log('Inside _recordAction in contextRecorder.ts: ' + action.name);
    // fs.writeFileSync('playwright_recorder_output/' + _uuid2 + ".html", await frame.content());
    this._collection.addRecordedAction(await this._createActionInContext(frame, action));
  }

  private _onFrameNavigated(frame: Frame, page: Page, content: string) {
    // _uuid = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    // fs.writeFileSync('playwright_recorder_output/' + _uuid + ".html", await frame.content());
    // console.log('Inside _onFrameNavigated in contextRecorder.ts: ' + frame.url());
    const pageAlias = this._pageAliases.get(page);
    this._collection.signal(pageAlias!, frame, { name: 'navigation', url: frame.url() }, content);
  }

  private _onPopup(page: Page, popup: Page, content: string) {
    // _uuid = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    // fs.writeFileSync('playwright_recorder_output/' + _uuid + ".html", await page.mainFrame().content());
    const frame = page.mainFrame();
    const pageAlias = this._pageAliases.get(page)!;
    const popupAlias = this._pageAliases.get(popup)!;
    this._collection.signal(pageAlias, frame, { name: 'popup', popupAlias }, content);
  }

  private _onDownload(page: Page, content: string) {
    // _uuid = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    // fs.writeFileSync('playwright_recorder_output/' + _uuid + ".html", await page.mainFrame().content());
    const frame = page.mainFrame();
    const pageAlias = this._pageAliases.get(page)!;
    ++this._lastDownloadOrdinal;
    this._collection.signal(pageAlias, frame, { name: 'download', downloadAlias: this._lastDownloadOrdinal ? String(this._lastDownloadOrdinal) : '' }, content);
  }

  private _onDialog(page: Page, content: string) {
    // _uuid = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    // fs.writeFileSync('playwright_recorder_output/' + _uuid + ".html", await page.mainFrame().content());
    const frame = page.mainFrame();
    const pageAlias = this._pageAliases.get(page)!;
    ++this._lastDialogOrdinal;
    this._collection.signal(pageAlias, frame, { name: 'dialog', dialogAlias: this._lastDialogOrdinal ? String(this._lastDialogOrdinal) : '' }, content);
  }
}

export async function generateFrameSelector(frame: Frame): Promise<string[]> {
  const selectorPromises: Promise<string>[] = [];
  while (frame) {
    const parent = frame.parentFrame();
    if (!parent)
      break;
    selectorPromises.push(generateFrameSelectorInParent(parent, frame));
    frame = parent;
  }
  const result = await Promise.all(selectorPromises);
  return result.reverse();
}

async function generateFrameSelectorInParent(parent: Frame, frame: Frame): Promise<string> {
  const result = await raceAgainstDeadline(async () => {
    try {
      const frameElement = await frame.frameElement();
      if (!frameElement || !parent)
        return;
      const utility = await parent._utilityContext();
      const injected = await utility.injectedScript();
      const selector = await injected.evaluate((injected, element) => {
        return injected.generateSelectorSimple(element as Element);
      }, frameElement);
      return selector;
    } catch (e) {
    }
  }, monotonicTime() + 2000);
  if (!result.timedOut && result.result)
    return result.result;

  if (frame.name())
    return `iframe[name=${quoteCSSAttributeValue(frame.name())}]`;
  return `iframe[src=${quoteCSSAttributeValue(frame.url())}]`;
}
