import sharedServiceInit from './sharedService';

const methods = {
  fakeWork: async (s: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, s * 1000));
  },
};

const sharedService = sharedServiceInit('myName', methods);

onmessage = async (event: MessageEvent) => {
  await sharedService.status.ready;
  await sharedService.proxy.fakeWork(event.data);
  postMessage('done');
};
