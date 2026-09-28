/**
 * POST multipart form data with upload progress (fetch has no upload progress
 * events). `onProgress` receives a 0-100 percentage. Resolves with the parsed
 * JSON body; rejects with the server's `error` message on non-2xx responses.
 */
export function uploadWithProgress<T>(
	url: string,
	body: FormData,
	onProgress: (percent: number) => void,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("POST", url);
		xhr.responseType = "json";
		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable) {
				onProgress(Math.round((event.loaded / event.total) * 100));
			}
		};
		xhr.onload = () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				onProgress(100);
				resolve(xhr.response as T);
				return;
			}
			const message = (xhr.response as { error?: string } | null)?.error;
			reject(new Error(message ?? "Upload failed"));
		};
		xhr.onerror = () => reject(new Error("Upload failed"));
		xhr.onabort = () => reject(new Error("Upload cancelled"));
		xhr.send(body);
	});
}
