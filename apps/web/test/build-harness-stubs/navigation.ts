// Stand-in for next/navigation in the browser-test harnesses: navigation does nothing on a bare page.
export const useRouter = () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} });
export const usePathname = () => "/";
export const useSearchParams = () => new URLSearchParams();
export const redirect = () => {
  throw new Error("redirect");
};
export const notFound = () => {
  throw new Error("notFound");
};
