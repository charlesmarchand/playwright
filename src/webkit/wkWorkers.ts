/**
 * Copyright 2019 Microsoft Corporation All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { helper, RegisteredListener } from '../helper';
import { Page, Worker } from '../page';
import { Protocol } from './protocol';
import { WKSession, WKTargetSession } from './wkConnection';
import { WKExecutionContext } from './wkExecutionContext';

export class WKWorkers {
  private _sessionListeners: RegisteredListener[] = [];
  private _page: Page;
  private _workerSessions = new Map<string, WKSession>();

  constructor(page: Page) {
    this._page = page;
  }

  setSession(session: WKTargetSession) {
    helper.removeEventListeners(this._sessionListeners);
    this._page._clearWorkers();
    this._workerSessions.clear();
    this._sessionListeners = [
      helper.addEventListener(session, 'Worker.workerCreated', async (event: Protocol.Worker.workerCreatedPayload) => {
        const worker = new Worker(event.url);
        const workerSession = new WKSession(session.connection, event.workerId, 'Most likely the worker has been closed.', (message: any) => {
          session.send('Worker.sendMessageToWorker', {
            workerId: event.workerId,
            message: JSON.stringify(message)
          }).catch(e => {
            workerSession.dispatchMessage({ id: message.id, error: { message: e.message } });
          });
        });
        this._workerSessions.set(event.workerId, workerSession);
        worker._createExecutionContext(new WKExecutionContext(workerSession, undefined));
        this._page._addWorker(event.workerId, worker);
        workerSession.on('Console.messageAdded', event => this._onConsoleMessage(worker, event));
        try {
          Promise.all([
            workerSession.send('Runtime.enable'),
            workerSession.send('Console.enable'),
            session.send('Worker.initialized', { workerId: event.workerId }).catch(e => {
              this._page._removeWorker(event.workerId);
            })
          ]);
        } catch (e) {
          // Worker can go as we are initializing it.
        }
      }),
      helper.addEventListener(session, 'Worker.dispatchMessageFromWorker', (event: Protocol.Worker.dispatchMessageFromWorkerPayload) => {
        const workerSession = this._workerSessions.get(event.workerId);
        workerSession.dispatchMessage(JSON.parse(event.message));
      }),
      helper.addEventListener(session, 'Worker.workerTerminated', (event: Protocol.Worker.workerTerminatedPayload) => {
        const workerSession = this._workerSessions.get(event.workerId);
        workerSession.dispose();
        this._workerSessions.delete(event.workerId);
        this._page._removeWorker(event.workerId);
      })
    ];
  }

  async initializeSession(session: WKTargetSession) {
    await session.send('Worker.enable');
  }

  async _onConsoleMessage(worker: Worker, event: Protocol.Console.messageAddedPayload) {
    const { type, level, text, parameters, url, line: lineNumber, column: columnNumber } = event.message;
    let derivedType: string = type;
    if (type === 'log')
      derivedType = level;
    else if (type === 'timing')
      derivedType = 'timeEnd';

    const handles = (parameters || []).map(p => {
      return worker._existingExecutionContext._createHandle(p);
    });
    this._page._addConsoleMessage(derivedType, handles, { url, lineNumber: lineNumber - 1, columnNumber: columnNumber - 1 }, handles.length ? undefined : text);
  }
}
