import { Helmet } from "react-helmet";
import { useSiteConfig } from "../hooks/useSiteConfig";
import { stripImageUrlMetadata } from "../utils/image-upload";

interface SiteMetaProps {
    title?: string;
    description?: string;
    image?: string;
    children: React.ReactNode;
}

// Component to provide site metadata for pages
export function SiteMeta({ title, description, image, children }: SiteMetaProps) {
    const siteConfig = useSiteConfig();

    const pageTitle = title 
        ? `${title} - ${siteConfig.name}` 
        : siteConfig.name;

    const pageDescription = description || siteConfig.description;
    const rawImage = stripImageUrlMetadata(image || siteConfig.avatar);
    // og:image 必须是绝对地址；用当前域名补全，保证副站分享出去也是副站自己的图
    const pageImage = rawImage
        ? new URL(rawImage, window.location.origin).href
        : "";

    return (
        <>
            <Helmet>
                <title>{pageTitle}</title>
                <meta property="og:title" content={pageTitle} />
                <meta property="og:description" content={pageDescription} />
                {pageImage && <meta property="og:image" content={pageImage} />}
            </Helmet>
            {children}
        </>
    );
}
