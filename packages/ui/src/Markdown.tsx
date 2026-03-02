import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import SyntaxHighlighter from "react-syntax-highlighter";
import { vs2015 } from "react-syntax-highlighter/dist/esm/styles/hljs";

const theme = {
	...vs2015,
	"hljs-addition": { ...vs2015["hljs-addition"], backgroundColor: "rgba(20, 66, 18, 0.3)" },
	"hljs-deletion": { ...vs2015["hljs-deletion"], backgroundColor: "rgba(102, 0, 0, 0.3)" },
};

const codeStyle: React.CSSProperties = {
	background: "transparent",
	padding: 0,
	margin: 0,
	fontFamily: "inherit",
	fontSize: "inherit",
	lineHeight: "inherit",
};

const components: Components = {
	code(props) {
		const { children, className, ref: _ref, ...rest } = props;
		const match = /language-(\w+)/.exec(className || "");
		if (match) {
			return (
				<SyntaxHighlighter language={match[1]} style={theme} customStyle={codeStyle} PreTag="div" {...rest}>
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

export function Markdown({ children }: { children: string }) {
	return (
		<div className="md">
			<ReactMarkdown components={components}>{children}</ReactMarkdown>
		</div>
	);
}
