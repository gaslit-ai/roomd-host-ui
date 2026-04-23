"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
	AssistantChatTransport,
	useChatRuntime,
} from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { PromptArgsDialogProvider } from "@/components/assistant-ui/prompt-arguments-dialog";
import { Thread } from "@/components/assistant-ui/thread";
import { ThreadListSidebar } from "@/components/assistant-ui/threadlist-sidebar";
import { DevSidebar } from "@/components/debug/dev-sidebar";
import { ResourceUIPanel } from "@/components/mcp/resource-ui-panel";
import { UnsafeEvalBadge } from "@/components/mcp/unsafe-eval-badge";
import { McpClientProvider } from "@/components/providers/mcp-client-provider";
import { McpHostContextProvider } from "@/components/providers/mcp-host-context-provider";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import { devTapFetch } from "@/lib/dev-event-log";

export const Assistant = () => {
	const runtime = useChatRuntime({
		sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
		transport: new AssistantChatTransport({
			api: "/api/chat",
			// Dev-only tap: mirrors every SSE event into the dev sidebar.
			// In prod the tap is a no-op passthrough, so we just omit it.
			...(process.env.NODE_ENV === "production" ? {} : { fetch: devTapFetch }),
		}),
	});

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<McpClientProvider>
				<McpHostContextProvider>
					<PromptArgsDialogProvider>
						<SidebarProvider>
							<div className="flex h-dvh w-full pr-0.5">
								<ThreadListSidebar />
								<SidebarInset>
									<header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
										<SidebarTrigger />
										<Separator orientation="vertical" className="mr-2 h-4" />
										<Breadcrumb>
											<BreadcrumbList>
												<BreadcrumbItem className="hidden md:block">
													<BreadcrumbLink
														href="https://www.assistant-ui.com/docs/getting-started"
														target="_blank"
														rel="noopener noreferrer"
													>
														Build Your Own ChatGPT UX
													</BreadcrumbLink>
												</BreadcrumbItem>
												<BreadcrumbSeparator className="hidden md:block" />
												<BreadcrumbItem>
													<BreadcrumbPage>Starter Template</BreadcrumbPage>
												</BreadcrumbItem>
											</BreadcrumbList>
										</Breadcrumb>
										<div className="ml-auto flex items-center gap-2">
											<UnsafeEvalBadge />
											<ResourceUIPanel />
										</div>
									</header>
									<div className="flex-1 overflow-hidden">
										<Thread />
									</div>
								</SidebarInset>
							</div>
						</SidebarProvider>
						<DevSidebar />
					</PromptArgsDialogProvider>
				</McpHostContextProvider>
			</McpClientProvider>
		</AssistantRuntimeProvider>
	);
};
