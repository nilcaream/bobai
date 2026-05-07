/**
 * AWS Event Stream binary protocol parser.
 *
 * Each message in the stream has this layout (all integers big-endian):
 *
 *  ┌────────────────────────┐
 *  │ total_length  (4 bytes)│
 *  │ headers_length(4 bytes)│
 *  │ prelude_crc   (4 bytes)│ ← CRC32 of the 8 preceding bytes (not validated)
 *  │ headers (headers_length bytes) │
 *  │ payload (total_length - headers_length - 16 bytes) │
 *  │ message_crc   (4 bytes)│
 *  └────────────────────────┘
 *
 * Each header entry:
 *  1 byte  name_length
 *  N bytes name
 *  1 byte  value_type (7 = string)
 *  2 bytes value_length
 *  M bytes value
 *
 * We extract the `:event-type` header and decode the payload as JSON.
 */

function readUint32BE(bytes: Uint8Array, offset: number): number {
	return (((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0) as number;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
	return (((bytes[offset] << 8) | bytes[offset + 1]) >>> 0) as number;
}

function parseHeaders(bytes: Uint8Array, start: number, end: number): Record<string, string> {
	const headers: Record<string, string> = {};
	let offset = start;
	const decoder = new TextDecoder();

	while (offset < end) {
		const nameLen = bytes[offset++];
		const name = decoder.decode(bytes.subarray(offset, offset + nameLen));
		offset += nameLen;

		const valueType = bytes[offset++];
		if (valueType === 7) {
			// string
			const valueLen = readUint16BE(bytes, offset);
			offset += 2;
			const value = decoder.decode(bytes.subarray(offset, offset + valueLen));
			offset += valueLen;
			headers[name] = value;
		}
		// Other value types are not used by Bedrock; skip gracefully if encountered
	}

	return headers;
}

export interface BedrockStreamEvent {
	eventType: string;
	payload: unknown;
}

/**
 * Parses an AWS Event Stream from a ReadableStream<Uint8Array>.
 * Yields parsed events with their event-type and JSON payload.
 * Error events (modelStreamErrorException, etc.) are thrown as errors.
 */
export async function* parseBedrockEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<BedrockStreamEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = new Uint8Array(0);

	function appendBuffer(incoming: Uint8Array): void {
		const merged = new Uint8Array(buffer.length + incoming.length);
		merged.set(buffer, 0);
		merged.set(incoming, buffer.length);
		buffer = merged;
	}

	try {
		while (true) {
			// Drain complete messages from buffer before reading more
			while (buffer.length >= 12) {
				const totalLength = readUint32BE(buffer, 0);
				const headersLength = readUint32BE(buffer, 4);

				if (buffer.length < totalLength) break; // incomplete message — wait for more bytes

				// headers occupy bytes [12, 12 + headersLength)
				const headersStart = 12;
				const headersEnd = headersStart + headersLength;
				const headers = parseHeaders(buffer, headersStart, headersEnd);

				// payload occupies bytes [12 + headersLength, totalLength - 4)
				const payloadStart = headersEnd;
				const payloadEnd = totalLength - 4;
				const payloadBytes = buffer.subarray(payloadStart, payloadEnd);

				// Advance buffer past the consumed message
				buffer = buffer.slice(totalLength);

				const eventType = headers[":event-type"];
				if (!eventType) continue;

				// Error events carry a message in the payload
				if (
					eventType === "internalServerException" ||
					eventType === "modelStreamErrorException" ||
					eventType === "validationException" ||
					eventType === "throttlingException" ||
					eventType === "serviceUnavailableException"
				) {
					let detail = "";
					try {
						const errPayload = JSON.parse(decoder.decode(payloadBytes)) as { message?: string };
						detail = errPayload.message ?? "";
					} catch {
						detail = decoder.decode(payloadBytes);
					}
					throw new Error(`Bedrock stream error (${eventType}): ${detail}`);
				}

				if (payloadBytes.length === 0) continue;

				try {
					const payload = JSON.parse(decoder.decode(payloadBytes));
					yield { eventType, payload };
				} catch {
					// ignore unparseable payloads
				}
			}

			const { done, value } = await reader.read();
			if (done) break;
			appendBuffer(value);
		}

		// Drain any remaining complete messages after the stream ends
		while (buffer.length >= 12) {
			const totalLength = readUint32BE(buffer, 0);
			const headersLength = readUint32BE(buffer, 4);
			if (buffer.length < totalLength) break;

			const headersEnd = 12 + headersLength;
			const headers = parseHeaders(buffer, 12, headersEnd);
			const payloadBytes = buffer.subarray(headersEnd, totalLength - 4);
			buffer = buffer.slice(totalLength);

			const eventType = headers[":event-type"];
			if (eventType && payloadBytes.length > 0) {
				try {
					const payload = JSON.parse(decoder.decode(payloadBytes));
					yield { eventType, payload };
				} catch {
					// ignore
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}
