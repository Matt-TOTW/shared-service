import { v4 as randomId } from 'uuid';

type ServiceEvent<T> = MessageEvent<
  | {
      method: T;
      args: any[];
      id: string;
      type: 'request';
    }
  | {
      method: T;
      id: string;
      type: 'response';
      result: any;
      error: any;
    }
>;

const commonChannel = new BroadcastChannel('shared-snapshot-store-common-channel');

const clientChannels = new Map<string, Map<string, BroadcastChannel>>();
const getBroadcastChannelName = (clientId: string, serviceName: string) =>
  `${clientId}-${serviceName}`;
let broadcastChannel: BroadcastChannel | null = null;

const getClientId = async () => {
  const id = randomId();
  const clientId = await navigator.locks.request(id, { mode: 'exclusive' }, async () => {
    const { held } = await navigator.locks.query();
    return held?.find((lock) => lock.name === id)?.clientId;
  });

  navigator.locks.request(clientId, { mode: 'exclusive' }, async () => {
    await new Promise(() => {}); // Keep the lock until this context is destroyed
  });

  return clientId;
};

export default (
  serviceName: string,
  target: { [method: string | symbol]: (...args: any[]) => any },
  onProviderChange?: (isServiceProvider: Promise<boolean>) => any
) => {
  type TargetKey = keyof typeof target;

  const requestsInFlight = new Map<
    string,
    {
      method: TargetKey;
      args: any[];
      resolve: (value: any) => void;
      reject: (reason?: any) => void;
    }
  >();

  const getOnRequestListener = (
    uuid: string,
    resolve: (value: any) => void,
    reject: (reason?: any) => void
  ) => {
    const listener = (event: ServiceEvent<TargetKey>) => {
      const { id, type } = event.data;
      if (id !== uuid || type === 'request') return;

      requestsInFlight.delete(uuid);
      broadcastChannel?.removeEventListener('message', listener);

      if (event.data.error) {
        console.error('Error processing request', event.data.error);
        return reject(event.data.error);
      }

      resolve(event.data.result);
    };

    return listener;
  };

  let readyResolve: (() => void) | null = null;
  const status = {
    ready: new Promise<void>((resolve) => {
      readyResolve = resolve;
    }),
    isServiceProvider: new Promise<boolean>((resolve) => {
      navigator.locks.query().then((locks) => {
        const isProvider = !locks.held?.find((lock) => lock.name === serviceName);
        resolve(isProvider);
        if (!isProvider) onNotProvider();
      });
    }),
  };

  navigator.locks.request(serviceName, { mode: 'exclusive' }, async () => {
    await onBecomeProvider();
    await new Promise(() => {}); // Keep the lock until this context is destroyed
  });

  const onNotProvider = async () => {
    const clientId = await getClientId();
    broadcastChannel = new BroadcastChannel(getBroadcastChannelName(clientId, serviceName));

    const register = async () =>
      await new Promise<void>((resolve) => {
        const onRegisteredListener = (event: MessageEvent) => {
          if (
            event.data.clientId === clientId &&
            event.data.serviceName === serviceName &&
            event.data.type === 'registered'
          ) {
            commonChannel.removeEventListener('message', onRegisteredListener);
            resolve();
          }
        };
        commonChannel.addEventListener('message', onRegisteredListener);
        commonChannel.postMessage({ type: 'register', clientId, serviceName });
      });

    commonChannel.addEventListener('message', async (event) => {
      if (
        event.data.type === 'providerChange' &&
        event.data.serviceName === serviceName &&
        !(await status.isServiceProvider)
      ) {
        console.log('Provider change detected. Re-registering with the new one...');
        await onProviderChange?.(status.isServiceProvider);
        await register();

        if (requestsInFlight.size > 0) {
          console.log('Requests were in flight when the provider changed. Requeuing...');
          requestsInFlight.forEach(async ({ method, args, resolve, reject }, uuid) => {
            const onRequestlistener = getOnRequestListener(uuid, resolve, reject);
            broadcastChannel?.addEventListener('message', onRequestlistener);
            broadcastChannel?.postMessage({ id: uuid, type: 'request', method, args });
          });
        }
      }
    });

    await register();

    readyResolve?.();
    readyResolve = null;
  };

  const onBecomeProvider = async () => {
    status.isServiceProvider = Promise.resolve(true);
    if (readyResolve === null) {
      status.ready = new Promise<void>((resolve) => {
        readyResolve = resolve;
      });
    }

    commonChannel.addEventListener('message', async (event) => {
      const { clientId, type } = event.data;
      if (type !== 'register') return;

      navigator.locks.request(clientId, { mode: 'exclusive' }, async () => {
        // The client has gone. Clean up
        clientChannels.get(clientId)?.forEach((channel) => channel.close());
        clientChannels.delete(clientId);
      });
      if (!clientChannels.has(clientId)) clientChannels.set(clientId, new Map());

      clientChannels
        .get(clientId)
        ?.set(serviceName, new BroadcastChannel(getBroadcastChannelName(clientId, serviceName)));

      const clientChannel = clientChannels.get(clientId)?.get(serviceName);

      clientChannel?.addEventListener('message', async (event: ServiceEvent<TargetKey>) => {
        if (event.data.type === 'response') return;
        const { method, args, id } = event.data;

        let result: any, error: any;
        try {
          result = await target[method](...args);
        } catch (e) {
          error =
            e instanceof Error
              ? Object.fromEntries(Object.getOwnPropertyNames(e).map((k) => [k, (e as any)[k]]))
              : e;
        }

        clientChannel?.postMessage({ id, type: 'response', result, error, method });
      });

      commonChannel.postMessage({ type: 'registered', clientId, serviceName });
    });

    commonChannel.postMessage({ type: 'providerChange', serviceName });

    await onProviderChange?.(status.isServiceProvider);

    if (requestsInFlight.size > 0) {
      console.log('Requests were in flight when this tab became the provider. Requeuing...');
      requestsInFlight.forEach(async ({ method, args, resolve, reject }, uuid) => {
        try {
          const result = await target[method](...args);
          resolve(result);
        } catch (error) {
          console.error('Error processing request', error);
          reject(error);
        } finally {
          requestsInFlight.delete(uuid);
        }
      });
    }

    readyResolve?.();
    readyResolve = null;
  };

  const proxy = new Proxy(target, {
    get: (target, method) => {
      if (method === 'then' || method === 'catch' || method === 'finally') {
        // Return undefined for these methods to allow promise chaining to work correctly
        return undefined;
      }

      return async (...args: any[]) => {
        if (await status.isServiceProvider) return await target[method](...args);

        return new Promise<any>((resolve, reject) => {
          const uuid = randomId();
          const onRequestlistener = getOnRequestListener(uuid, resolve, reject);
          broadcastChannel?.addEventListener('message', onRequestlistener);

          broadcastChannel?.postMessage({ id: uuid, type: 'request', method, args });
          requestsInFlight.set(uuid, { method, args, resolve, reject });
        });
      };
    },
  });

  return { proxy, status };
};
