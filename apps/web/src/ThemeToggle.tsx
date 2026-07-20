import { Check, Palette, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { themeChange } from "theme-change";

const THEMES = [
	"solar-light",
	"solar-dark",
	"light",
	"dark",
	"cupcake",
	"bumblebee",
	"emerald",
	"corporate",
	"synthwave",
	"retro",
	"cyberpunk",
	"valentine",
	"halloween",
	"garden",
	"forest",
	"aqua",
	"lofi",
	"pastel",
	"fantasy",
	"wireframe",
	"black",
	"luxury",
	"dracula",
	"cmyk",
	"autumn",
	"business",
	"acid",
	"lemonade",
	"night",
	"coffee",
	"winter",
	"dim",
	"nord",
	"sunset",
	"caramellatte",
	"abyss",
	"silk",
] as const;

export function ThemeToggle() {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const [query, setQuery] = useState("");
	const [currentTheme, setCurrentTheme] = useState("wireframe");

	useEffect(() => {
		themeChange(false);
		setCurrentTheme(document.documentElement.dataset.theme ?? "wireframe");
	}, []);

	const visibleThemes = useMemo(
		() => THEMES.filter((theme) => theme.includes(query.trim().toLowerCase())),
		[query],
	);

	const selectTheme = (theme: string) => {
		setCurrentTheme(theme);
		dialogRef.current?.close();
	};

	const open = () => {
		setQuery("");
		dialogRef.current?.showModal();
	};

	return (
		<>
			<div className="tooltip tooltip-bottom" data-tip="Change theme">
				<button
					type="button"
					className="btn btn-ghost btn-sm btn-circle"
					onClick={open}
				>
					<Palette size={18} />
				</button>
			</div>
			{createPortal(
				<dialog ref={dialogRef} className="modal modal-bottom sm:modal-middle">
					<div className="modal-box max-h-[85dvh] w-full max-w-2xl overflow-hidden p-0">
						<div className="flex items-center justify-between border-b border-base-300 px-5 py-4">
							<div>
								<h2 className="font-sans text-lg font-semibold">
									Choose a theme
								</h2>
								<p className="text-sm opacity-60">
									{THEMES.length} themes, saved automatically
								</p>
							</div>
							<button
								type="button"
								className="btn btn-ghost btn-sm btn-circle"
								onClick={() => dialogRef.current?.close()}
							>
								<X size={18} />
							</button>
						</div>
						<div className="space-y-4 p-5">
							<input
								type="search"
								className="input w-full"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="Search themes"
							/>
							<div className="grid max-h-[55dvh] grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3">
								{visibleThemes.map((theme) => (
									<button
										key={theme}
										type="button"
										data-theme={theme}
										data-set-theme={theme}
										data-key="solar-daisy-theme"
										onClick={() => selectTheme(theme)}
										className="btn h-auto min-h-14 justify-between border-base-300 bg-base-100 px-3 py-2 text-left text-base-content hover:bg-base-200"
									>
										<span className="truncate">{theme.replace("-", " ")}</span>
										{currentTheme === theme && (
											<Check className="shrink-0" size={16} />
										)}
									</button>
								))}
							</div>
						</div>
					</div>
					<form method="dialog" className="modal-backdrop">
						<button>close</button>
					</form>
				</dialog>,
				document.body,
			)}
		</>
	);
}
