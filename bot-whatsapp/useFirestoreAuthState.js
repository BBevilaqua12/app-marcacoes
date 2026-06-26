import { proto, BufferJSON, initAuthCreds } from 'baileys';

export const useFirestoreAuthState = async (db, sessionId = 'default') => {
    const credsRef = db.collection('whatsapp_sessions').doc(sessionId).collection('auth').doc('creds');
    const keysRef = db.collection('whatsapp_sessions').doc(sessionId).collection('auth_keys');

    const readData = async (docRef) => {
        const doc = await docRef.get();
        if (doc.exists) {
            return JSON.parse(JSON.stringify(doc.data().data), BufferJSON.reviver);
        }
        return null;
    };

    const writeData = async (docRef, data) => {
        const parsed = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        await docRef.set({ data: parsed });
    };

    const removeData = async (docRef) => {
        try {
            await docRef.delete();
        } catch (e) {
            // ignora se não existir
        }
    };

    let creds = await readData(credsRef);
    if (!creds) {
        creds = initAuthCreds();
        await writeData(credsRef, creds);
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(keysRef.doc(`${type}-${id}`));
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const docRef = keysRef.doc(`${category}-${id}`);
                            if (value) {
                                tasks.push(writeData(docRef, value));
                            } else {
                                tasks.push(removeData(docRef));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData(credsRef, creds);
        }
    };
};
