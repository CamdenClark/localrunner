export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
