import { type CSSProperties, memo } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import SyntaxHighlighter from "react-syntax-highlighter";
import { vs2015 } from "react-syntax-highlighter/dist/esm/styles/hljs";
import remarkGfm from "remark-gfm";

const theme = {
	...vs2015,
	"hljs-addition": { ...(vs2015["hljs-addition"] as CSSProperties), backgroundColor: "rgba(20, 66, 18, 0.3)" },
	"hljs-deletion": { ...(vs2015["hljs-deletion"] as CSSProperties), backgroundColor: "rgba(102, 0, 0, 0.3)" },
};

const codeStyle: React.CSSProperties = {
	background: "transparent",
	padding: 0,
	margin: 0,
	fontFamily: "inherit",
	fontSize: "inherit",
	lineHeight: "inherit",
	overflowX: "hidden",
	whiteSpace: "pre-wrap",
	wordWrap: "break-word",
};

const components: Components = {
	code(props) {
		const { children, className, ref: _ref, node: _node, style: _style, ...rest } = props;
		const match = /language-(\w+)/.exec(className || "");
		if (match) {
			return (
				<SyntaxHighlighter
					language={match[1]}
					style={theme as Record<string, CSSProperties>}
					customStyle={codeStyle}
					wrapLongLines
					PreTag="div"
					{...rest}
				>
					{String(children).replace(/\n$/, "")}
				</SyntaxHighlighter>
			);
		}
		return (
			<code className={className} {...rest}>
				{children}
			</code>
		);
	},
};

export const Markdown = memo(function Markdown({ children }: { children: string }) {
	return (
		<div className="md">
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
				{children}
			</ReactMarkdown>
		</div>
	);
});
